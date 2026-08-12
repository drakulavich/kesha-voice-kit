import { join, basename } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
  resolveKeshaBin,
} from "./kesha-bin";
import type { EnginePreflightResult, KeshaSpawn } from "./kesha-bin";
import { startKeshaRecorder, startKeshaTranscriber } from "./process-tasks";
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
  let audioCaptured = false;
  let keepAudio = false;
  let stopMonitoring: (() => void) | null = null;
  let recorder: RunningTask<void> | null = null;
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
      setState({ status: "error", message: "Transcription cancelled." });
    },
    cancel: () => {
      cancelled = true;
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

      tempDir = await deps.createTempDir();
      audioPath = join(tempDir, "dictation.wav");

      if (!(await recordPhase(kesha, audioPath, maxSeconds))) return;

      if (await deps.isSilentAudio(audioPath)) {
        throw new Error(
          "Recorded audio is silent. Check macOS Microphone permission for Raycast and the selected input device.",
        );
      }

      // Past the silence check the temp WAV holds real speech: a transcription
      // failure below must keep it, not discard it (#944).
      audioCaptured = true;

      const result = await transcribePhase(kesha, audioPath);
      if (!result || cancelled) return;

      await deliverTranscript(result);
    } catch (err: unknown) {
      if (cancelled) return;
      keepAudio = audioCaptured;
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

  async function recordPhase(
    kesha: KeshaSpawn,
    audioPath: string,
    maxSeconds: number,
  ): Promise<boolean> {
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
    if (cancelled) return false;
    if (stopRequested) {
      setState({
        status: "error",
        message: "Recording stopped before any audio was captured.",
      });
      return false;
    }

    recorder = deps.startRecorder(kesha, audioPath, maxSeconds);
    const recorderStartedAt = now();
    try {
      await recorder.done;
    } finally {
      // Wall-clock capture length ≈ audio duration; it feeds the scaled
      // transcription timeout so a long recording keeps proportional room (#944).
      recordedSeconds = Math.max(0, (now() - recorderStartedAt) / 1000);
      recorder = null;
      stopMonitoring?.();
      stopMonitoring = null;
    }
    return !cancelled;
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
    const transcript = result.text.trim();
    if (!transcript) {
      throw new Error("No speech was detected in the recording.");
    }
    await deps.copyToClipboard(transcript);
    await deps.showToast({
      style: "success",
      title: "Copied transcript",
    });
    setState({
      status: "ok",
      result: { ...result, text: transcript },
    });
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
    createTempDir: () => mkdtemp(join(tmpdir(), "raycast-kesha-dictate-")),
    cleanupTempDir: (dir) => rm(dir, { recursive: true, force: true }),
    startRecordingMonitor,
    startRecorder: (kesha, audioPath, maxSeconds) =>
      startKeshaRecorder(kesha, audioPath, maxSeconds),
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
  if (!text) {
    throw new Error("No transcript returned.");
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
