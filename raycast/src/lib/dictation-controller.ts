import { join, basename } from "node:path";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  IDLE_STOP_GRACE_MS,
  IDLE_WARN_MS,
  NO_SIGNAL_TIMEOUT_MS,
  parseMaxSeconds,
  transcribeTimeoutMs,
} from "./dictation-config";
import {
  notFoundMessage,
  probeEngineAvailability,
  RECORD_LIVE_FEATURE,
  resolveKeshaBin,
} from "./kesha-bin";
import type { EnginePreflightResult, KeshaSpawn } from "./kesha-bin";
import {
  startKeshaLiveRecorder,
  startKeshaRecorder,
  startKeshaTranscriber,
} from "./process-tasks";
import { startRecordingMonitor } from "./recording-monitor";
import { emptySignal } from "./recording-view";
import type {
  DictationControllerDeps,
  DictationPrefs,
  DictationSession,
  DictationState,
  RecordingPatch,
  RunningTask,
  TranscribeResult,
} from "./dictation-types";
import { isSilentWavFile } from "./wav";

export type DictationStateSetter = (
  next: DictationState | ((current: DictationState) => DictationState),
) => void;

export function startDictationSession(
  prefs: DictationPrefs,
  setState: DictationStateSetter,
  deps: DictationControllerDeps,
): DictationSession {
  let cancelled = false;
  let stopRequested = false;
  let tempDir: string | null = null;
  let audioPath: string | null = null;
  let recordedSeconds = 0;
  // captureComplete latches when recordPhase returns — the WAV exists on disk
  // from that instant, before the multi-second silence read — so a dismiss or
  // failure during that read still keeps it. confirmedSilent is the separate
  // decision that a recording proven silent may be deleted (#944).
  let captureComplete = false;
  let confirmedSilent = false;
  let keepAudio = false;
  let stopMonitoring: (() => void) | null = null;
  let recorder: RunningTask<unknown> | null = null;
  let transcriber: RunningTask<string> | null = null;
  let stopTranscribeTimer: (() => void) | null = null;

  const session: DictationSession = {
    stopRecording: () => {
      stopRequested = true;
      setState({ status: "stopping" });
      recorder?.stop();
    },
    cancelTranscription: () => {
      cancelled = true;
      transcriber?.stop();
      stopTranscribeTimer?.();
      // A deliberate cancel of transcription must not cost the recording once
      // it has been captured — keep it and name it, same as a failure (#944).
      if (captureComplete && audioPath) {
        keepAudio = true;
        setState({
          status: "error",
          message: "Transcription cancelled.",
          hint: keptAudioHint(audioPath),
        });
      } else {
        setState({ status: "error", message: "Transcription cancelled." });
      }
    },
    cancel: () => {
      cancelled = true;
      if (captureComplete) keepAudio = true;
      recorder?.stop();
      transcriber?.stop();
      stopMonitoring?.();
      stopTranscribeTimer?.();
    },
    done: Promise.resolve(),
  };

  session.done = run();
  return session;

  async function run() {
    // Best-effort sweep of recordings kept by earlier failed sessions (#944);
    // fire-and-forget so it never delays the microphone.
    void deps.pruneOldRecordings();
    try {
      const maxSeconds = parseMaxSeconds(prefs.maxRecordingSeconds);
      const kesha = await deps.resolveKesha(prefs.keshaBinPath);
      if (!kesha) {
        setState({
          status: "error",
          message: "kesha CLI not found.",
          hint: notFoundMessage(),
        });
        return;
      }

      const preflight = await deps.preflight(kesha);
      if (!preflight.ok) {
        setState({
          status: "error",
          message: preflightMessage(preflight.reason),
          hint: preflight.hint ?? notFoundMessage(),
        });
        return;
      }
      if (cancelled) return;

      if (preflight.features?.includes(RECORD_LIVE_FEATURE)) {
        const live = await recordPhase(
          () => deps.startLiveRecorder(kesha, maxSeconds),
          maxSeconds,
        );
        if (!live.ok) return;
        await deliverTranscript({ file: "", text: live.value.trim() });
        return;
      }

      tempDir = await deps.createTempDir();
      const file = join(tempDir, "dictation.wav");
      audioPath = file;

      const captured = await recordPhase(
        () => deps.startRecorder(kesha, file, maxSeconds),
        maxSeconds,
      );
      if (!captured.ok) return;

      // The WAV is on disk now; a dismiss or failure past this point — even
      // during the silence read below — must not discard it (#944).
      captureComplete = true;

      if (await deps.isSilentAudio(audioPath)) {
        confirmedSilent = true;
        throw new Error(
          "Recorded audio is silent. Check macOS Microphone permission for Raycast and the selected input device.",
        );
      }

      const result = await transcribePhase(kesha, audioPath);
      if (!result || cancelled) return;

      await deliverTranscript(result);
    } catch (err: unknown) {
      if (cancelled) {
        if (captureComplete) keepAudio = true;
        return;
      }
      // A recording proven silent is worthless — delete it; any other
      // post-capture failure keeps the recording for recovery (#944).
      keepAudio = captureComplete && !confirmedSilent;
      await deps.showToast({ style: "failure", title: "Dictation failed" });
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        hint: keepAudio && audioPath ? keptAudioHint(audioPath) : undefined,
      });
    } finally {
      releaseResources();
      // Keep the recording when transcription failed so it can be recovered
      // from the CLI; otherwise the private temp dir is cleaned up (#944).
      if (tempDir && !keepAudio) await deps.cleanupTempDir(tempDir);
    }
  }

  async function recordPhase<T>(
    startTask: () => RunningTask<T>,
    maxSeconds: number,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    setState({
      status: "recording",
      maxSeconds,
      elapsedSeconds: 0,
      silentForMs: 0,
      idle: false,
      mic: { name: "Default input device" },
      signal: emptySignal("starting"),
    });
    const silenceTracker = createSilenceTracker({
      now: deps.now,
      onIdleStop: () => {
        void deps.showToast({
          style: "animated",
          title: "Stopped after silence.",
        });
        recorder?.stop();
      },
    });
    const now = deps.now ?? Date.now;
    const recordingStartedAt = now();
    let sawMeterSample = false;
    let warnedNoSignal = false;
    stopMonitoring = deps.startRecordingMonitor((patch) => {
      const state = patch.signal?.state;
      if (state === "listening" || state === "signal") {
        sawMeterSample = true;
      }
      // Warn but keep going: a dead meter must not abort a session that may
      // still be capturing audio (the meter-unavailable contract).
      if (
        !sawMeterSample &&
        !warnedNoSignal &&
        now() - recordingStartedAt >= NO_SIGNAL_TIMEOUT_MS
      ) {
        warnedNoSignal = true;
        void deps.showToast({
          style: "failure",
          title: "No signal from the microphone",
          message:
            "Check macOS Microphone permission for Raycast. Recording continues.",
        });
      }
      patchRecordingState(setState, silenceTracker.track(patch));
    });
    await deps.showToast({
      style: "animated",
      title: "Recording",
      message: "Stops automatically when you pause",
    });
    if (cancelled) return { ok: false };
    if (stopRequested) {
      setState({
        status: "error",
        message: "Recording stopped before any audio was captured.",
      });
      return { ok: false };
    }

    const task = startTask();
    recorder = task;
    const recorderStartedAt = now();
    let value: T;
    try {
      value = await task.done;
    } finally {
      // Wall-clock capture length ≈ audio duration; it feeds the scaled
      // transcription timeout so a long recording keeps proportional room (#944).
      recordedSeconds = Math.max(0, (now() - recorderStartedAt) / 1000);
      recorder = null;
      stopMonitoring?.();
      stopMonitoring = null;
    }
    return cancelled ? { ok: false } : { ok: true, value };
  }

  async function transcribePhase(
    kesha: KeshaSpawn,
    audioPath: string,
  ): Promise<TranscribeResult | null> {
    const timeoutMs = transcribeTimeoutMs(recordedSeconds);
    setState({
      status: "transcribing",
      elapsedSeconds: 0,
      timeoutSeconds: Math.round(timeoutMs / 1000),
    });
    await deps.showToast({
      style: "animated",
      title: "Transcribing",
      message: basename(audioPath),
    });
    if (cancelled) return null;

    stopTranscribeTimer = startTranscribingTimer(setState);
    transcriber = deps.startTranscriber(kesha, audioPath, timeoutMs);
    const result = normalizeTranscribeResult(audioPath, await transcriber.done);
    stopTranscribeTimer?.();
    stopTranscribeTimer = null;
    transcriber = null;
    return result;
  }

  async function deliverTranscript(result: TranscribeResult) {
    await deps.copyToClipboard(result.text);
    await deps.showToast({
      style: "success",
      title: "Copied transcript",
    });
    setState({ status: "ok", result });
  }

  function releaseResources() {
    recorder = null;
    transcriber = null;
    stopMonitoring?.();
    stopMonitoring = null;
    stopTranscribeTimer?.();
    stopTranscribeTimer = null;
  }
}

// Names the surviving recording and a copy-paste CLI command so a failed
// transcription is recoverable instead of lost (#944).
export function keptAudioHint(audioPath: string): string {
  return [
    `Your recording was kept at ${audioPath}`,
    `Transcribe it from a terminal with: kesha "${audioPath}"`,
  ].join("\n");
}

const RECORDING_TEMP_PREFIX = "raycast-kesha-dictate-";
const RECORDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A recording kept after a failed session (#944) has no owner to delete it, so
// prune week-old ones on the next start — the raycast analog of the engine's
// recovery-WAV prune (#965). The age cut protects a concurrent session's
// fresh temp dir.
export function staleRecordingDirs(
  entries: { name: string; mtimeMs: number }[],
  nowMs: number,
  maxAgeMs: number = RECORDING_MAX_AGE_MS,
): string[] {
  return entries
    .filter(
      (entry) =>
        entry.name.startsWith(RECORDING_TEMP_PREFIX) &&
        nowMs - entry.mtimeMs > maxAgeMs,
    )
    .map((entry) => entry.name);
}

export interface PruneRecordingsDeps {
  baseDir?: string;
  readdir?: (dir: string) => Promise<string[]>;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
  rm?: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
  now?: () => number;
}

export async function pruneOldRecordings(
  deps: PruneRecordingsDeps = {},
): Promise<void> {
  const base = deps.baseDir ?? tmpdir();
  const readdirFn = deps.readdir ?? ((dir: string) => readdir(dir));
  const statFn = deps.stat ?? ((path: string) => stat(path));
  const rmFn =
    deps.rm ??
    ((path: string, options: { recursive: boolean; force: boolean }) =>
      rm(path, options));
  const nowMs = (deps.now ?? Date.now)();

  let names: string[];
  try {
    names = await readdirFn(base);
  } catch {
    return;
  }
  const candidates = names.filter((name) =>
    name.startsWith(RECORDING_TEMP_PREFIX),
  );
  const entries = await Promise.all(
    candidates.map(async (name) => {
      try {
        const info = await statFn(join(base, name));
        return { name, mtimeMs: info.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const present = entries.filter(
    (entry): entry is { name: string; mtimeMs: number } => entry !== null,
  );
  await Promise.all(
    staleRecordingDirs(present, nowMs).map((name) =>
      rmFn(join(base, name), { recursive: true, force: true }),
    ),
  );
}

// Each reason has a different remedy, so the headline tracks it, not just the hint (#647).
function preflightMessage(reason: EnginePreflightResult["reason"]): string {
  switch (reason) {
    case "unusable":
      return "Kesha's engine is installed but not working.";
    case "contract":
      return "Kesha CLI and this extension are out of sync.";
    default:
      return "Kesha setup isn't finished yet.";
  }
}

function defaultPreflight(kesha: KeshaSpawn): Promise<EnginePreflightResult> {
  return probeEngineAvailability(kesha);
}

export function createDefaultDictationDeps(
  adapter: Pick<DictationControllerDeps, "copyToClipboard" | "showToast">,
): DictationControllerDeps {
  return {
    ...adapter,
    resolveKesha: resolveKeshaBin,
    preflight: defaultPreflight,
    createTempDir: () => mkdtemp(join(tmpdir(), RECORDING_TEMP_PREFIX)),
    cleanupTempDir: (dir) => rm(dir, { recursive: true, force: true }),
    pruneOldRecordings: () => pruneOldRecordings(),
    startRecordingMonitor,
    startRecorder: (kesha, audioPath, maxSeconds) =>
      startKeshaRecorder(kesha, audioPath, maxSeconds),
    startLiveRecorder: (kesha, maxSeconds) =>
      startKeshaLiveRecorder(kesha, maxSeconds),
    startTranscriber: (kesha, audioPath, timeoutMs) =>
      startKeshaTranscriber(kesha, audioPath, timeoutMs),
    isSilentAudio: isSilentWavFile,
  };
}

export interface SilenceTrackerDeps {
  onIdleStop: () => void;
  now?: () => number;
}

export function createSilenceTracker(deps: SilenceTrackerDeps): {
  track: (patch: RecordingPatch) => RecordingPatch;
} {
  const now = deps.now ?? Date.now;
  // Time since the last confirmed speech, seeded at recording start: only a
  // meter that reports speech may push the deadline out, so a meter that dies,
  // hangs, or never starts still lands on the idle stop instead of the cap.
  let lastSignalAt = now();
  let idleStopTriggered = false;

  return {
    track: (patch) => {
      const state = patch.signal?.state;
      if (state === "starting" || state === "signal") {
        lastSignalAt = now();
        return { ...patch, silentForMs: 0, idle: false };
      }
      const silentForMs = Math.max(0, now() - lastSignalAt);
      if (
        silentForMs >= IDLE_WARN_MS + IDLE_STOP_GRACE_MS &&
        !idleStopTriggered
      ) {
        idleStopTriggered = true;
        deps.onIdleStop();
      }
      return { ...patch, silentForMs, idle: silentForMs >= IDLE_WARN_MS };
    },
  };
}

export function patchRecordingState(
  setState: DictationStateSetter,
  patch: RecordingPatch,
) {
  setState((current) => {
    if (current.status !== "recording") return current;
    return { ...current, ...patch };
  });
}

export function normalizeTranscribeResult(
  audioPath: string,
  stdout: string,
): TranscribeResult {
  const text = stdout.trim();
  // The only empty-transcript guard on the path, so it carries the wording the
  // user needs — talking too quietly is the common cause, not a broken CLI (#943).
  if (!text) {
    throw new Error("No speech was detected in the recording.");
  }
  return { file: audioPath, text };
}

export function startTranscribingTimer(
  setState: DictationStateSetter,
  deps: {
    now?: () => number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  } = {},
): () => void {
  const now = deps.now ?? Date.now;
  const schedule = deps.setInterval ?? setInterval;
  const unschedule = deps.clearInterval ?? clearInterval;
  const startedAt = now();
  const tick = () => {
    setState((current) => {
      if (current.status !== "transcribing") return current;
      return {
        ...current,
        elapsedSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      };
    });
  };
  const timer = schedule(tick, 500);
  return () => unschedule(timer);
}
