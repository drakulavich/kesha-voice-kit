import { describe, expect, it, vi } from "vitest";
import {
  createSilenceTracker,
  normalizeLiveTranscript,
  normalizeTranscribeResult,
  pruneOldRecordings,
  staleRecordingDirs,
  startDictationSession,
  startTranscribingTimer,
} from "../src/lib/dictation-controller";
import type {
  DictationControllerDeps,
  DictationSession,
  DictationState,
  LiveRecorderTask,
  RecordingPatch,
  RunningTask,
  SignalLevel,
} from "../src/lib/dictation-types";
import { emptySignal } from "../src/lib/recording-view";
import { startKeshaLiveRecorder } from "../src/lib/process-tasks";
import { createSpawnRecorder } from "./helpers/fake-process";
import { deferred, flushPromises, waitFor } from "./helpers/async";

describe("dictation controller", () => {
  it("waits for queued setup before asserting controller state", async () => {
    let ready = false;
    let attempts = 0;
    queueMicrotask(() => {
      ready = true;
    });

    await waitFor(() => {
      attempts++;
      expect(ready).toBe(true);
    });

    expect(attempts).toBeGreaterThan(1);
  });

  it("runs the happy path and copies the trimmed transcript", async () => {
    const deps = createDeps();
    const { states, toasts } = deps;
    const session = startDictationSession({}, deps.setState, deps);

    await session.done;

    expect(states.map((state) => state.status)).toEqual([
      "recording",
      "transcribing",
      "ok",
    ]);
    expect(deps.copyToClipboard).toHaveBeenCalledWith("hello world");
    expect(toasts).toEqual([
      {
        style: "animated",
        title: "Recording",
        message: "Stops automatically when you pause",
      },
      {
        style: "animated",
        title: "Transcribing",
        message: "dictation.wav",
      },
      { style: "success", title: "Copied transcript" },
    ]);
    expect(deps.cleanupTempDir).toHaveBeenCalledWith("/tmp/session");
  });

  it("does not transcribe silent audio and still cleans up", async () => {
    const deps = createDeps({
      isSilentAudio: vi.fn(async () => true),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.startTranscriber).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({
      status: "error",
      message:
        "Recorded audio is silent. Check macOS Microphone permission for Raycast and the selected input device.",
    });
    expect(deps.toasts).toContainEqual({
      style: "failure",
      title: "Dictation failed",
    });
    expect(deps.cleanupTempDir).toHaveBeenCalledWith("/tmp/session");
  });

  it("surfaces recorder failures and skips transcription", async () => {
    const deps = createDeps({
      startRecorder: vi.fn(() =>
        resolvedTask(Promise.reject(new Error("mic denied"))),
      ),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.startTranscriber).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({
      status: "error",
      message: "mic denied",
    });
  });

  it("shows an actionable error when kesha cannot be resolved", async () => {
    const deps = createDeps({
      resolveKesha: vi.fn(async () => null),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.createTempDir).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      status: "error",
      message: "kesha CLI not found.",
      hint: expect.stringContaining("bun add -g @drakulavich/kesha-voice-kit"),
    });
  });

  it("shows a finish-setup error naming kesha install when the engine is missing", async () => {
    const deps = createDeps({
      preflight: vi.fn(async () => ({
        ok: false,
        hint: "Run `kesha install` to download the engine and models.",
      })),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.createTempDir).not.toHaveBeenCalled();
    expect(deps.startRecorder).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      status: "error",
      message: "Kesha setup isn't finished yet.",
      hint: "Run `kesha install` to download the engine and models.",
    });
  });

  it("names a broken install differently from a missing one (#647)", async () => {
    const deps = createDeps({
      preflight: vi.fn(async () => ({
        ok: false,
        reason: "unusable" as const,
        hint: "Run `kesha install --no-cache` to re-download the engine.",
      })),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.startRecorder).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      status: "error",
      message: "Kesha's engine is installed but not working.",
      hint: "Run `kesha install --no-cache` to re-download the engine.",
    });
  });

  it("does not blame the engine for a CLI/extension version skew (#647)", async () => {
    const deps = createDeps({
      preflight: vi.fn(async () => ({
        ok: false,
        reason: "contract" as const,
        hint: "Update the kesha CLI and this extension to matching versions.",
      })),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.startRecorder).not.toHaveBeenCalled();
    const last = states.at(-1);
    expect(last?.message).toBe("Kesha CLI and this extension are out of sync.");
    expect(last?.message).not.toContain("engine");
  });

  it("falls back to the not-found hint when preflight fails without one", async () => {
    const deps = createDeps({
      preflight: vi.fn(async () => ({ ok: false })),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.startRecorder).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({
      status: "error",
      message: "Kesha setup isn't finished yet.",
      hint: expect.stringContaining("kesha install"),
    });
  });

  it("does not start recording when cancelled during preflight", async () => {
    const preflight = deferred<{ ok: boolean }>();
    const deps = createDeps({
      preflight: vi.fn(() => preflight.promise),
    });

    const session = startDictationSession({}, deps.setState, deps);
    session.cancel();
    preflight.resolve({ ok: true });
    await session.done;

    expect(deps.createTempDir).not.toHaveBeenCalled();
    expect(deps.startRecorder).not.toHaveBeenCalled();
  });

  it("proceeds to recording once preflight passes", async () => {
    const deps = createDeps();
    const session = startDictationSession({}, deps.setState, deps);

    await session.done;

    expect(deps.preflight).toHaveBeenCalledWith({
      command: "kesha",
      prefixArgs: [],
    });
    expect(deps.startRecorder).toHaveBeenCalled();
  });

  it("lets the user stop recording and cancels running work on unmount", async () => {
    const recorder = deferred<void>();
    const recorderStop = vi.fn();
    const transcriberStop = vi.fn();
    const deps = createDeps({
      startRecorder: vi.fn(() => ({
        done: recorder.promise,
        stop: recorderStop,
      })),
      startTranscriber: vi.fn(() => ({
        done: Promise.resolve("ignored"),
        stop: transcriberStop,
      })),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startRecorder).toHaveBeenCalled());
    session.stopRecording();
    session.cancel();
    recorder.resolve();
    await session.done;

    expect(states.some((state) => state.status === "stopping")).toBe(true);
    expect(recorderStop).toHaveBeenCalled();
    expect(transcriberStop).not.toHaveBeenCalled();
  });

  it("does not start the recorder when stop is requested during the recording toast", async () => {
    const recordingToast = deferred<void>();
    const deps = createDeps({
      showToast: vi.fn(async (toast) => {
        deps.toasts.push(toast);
        if (toast.title === "Recording") {
          await recordingToast.promise;
        }
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.current().status).toBe("recording"));

    session.stopRecording();
    expect(deps.startRecorder).not.toHaveBeenCalled();
    expect(deps.states.some((state) => state.status === "stopping")).toBe(true);

    recordingToast.resolve();
    await session.done;

    expect(deps.startRecorder).not.toHaveBeenCalled();
    expect(deps.startTranscriber).not.toHaveBeenCalled();
    expect(deps.current()).toMatchObject({
      status: "error",
      message: "Recording stopped before any audio was captured.",
    });
    expect(deps.cleanupTempDir).toHaveBeenCalledWith("/tmp/session");
  });

  it("does not start the recorder if unmounted before recorder creation", async () => {
    const recordingToast = deferred<void>();
    const deps = createDeps({
      showToast: vi.fn(async (toast) => {
        deps.toasts.push(toast);
        if (toast.title === "Recording") {
          await recordingToast.promise;
        }
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.current().status).toBe("recording"));

    session.cancel();
    recordingToast.resolve();
    await session.done;

    expect(deps.startRecorder).not.toHaveBeenCalled();
    expect(deps.cleanupTempDir).toHaveBeenCalledWith("/tmp/session");
  });

  it("keeps recording when the meter is unavailable", async () => {
    const recorder = deferred<void>();
    const deps = createDeps({
      startRecorder: vi.fn(() => resolvedTask(recorder.promise)),
      startRecordingMonitor: vi.fn((onPatch) => {
        onPatch({ signal: emptySignal("unavailable") });
        return vi.fn();
      }),
    });
    const { current } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await flushPromises();

    expect(current()).toMatchObject({
      status: "recording",
      signal: { state: "unavailable" },
    });

    recorder.resolve();
    await session.done;
    expect(deps.startTranscriber).toHaveBeenCalled();
  });

  it("shows transcribing elapsed state and can cancel transcription", async () => {
    const transcriber = deferred<string>();
    const transcriberStop = vi.fn();
    const deps = createDeps({
      startTranscriber: vi.fn(() => ({
        done: transcriber.promise,
        stop: transcriberStop,
      })),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(states.at(-1)?.status).toBe("transcribing"));

    expect(states.at(-1)).toMatchObject({
      status: "transcribing",
      elapsedSeconds: 0,
      timeoutSeconds: 60,
    });

    session.cancelTranscription();
    expect(transcriberStop).toHaveBeenCalled();
    const cancelled = states.at(-1);
    expect(cancelled).toMatchObject({
      status: "error",
      message: "Transcription cancelled.",
    });
    // Cancelling after capture keeps the recording and names it (#944).
    expect(cancelled?.status === "error" && cancelled.hint).toContain(
      "/tmp/session/dictation.wav",
    );
    expect(deps.cleanupTempDir).not.toHaveBeenCalled();

    transcriber.resolve("ignored");
    await session.done;
  });

  it("does not start the transcriber when cancelled during the transcribing toast", async () => {
    const transcribingToast = deferred<void>();
    const deps = createDeps({
      showToast: vi.fn(async (toast) => {
        deps.toasts.push(toast);
        if (toast.title === "Transcribing") {
          await transcribingToast.promise;
        }
      }),
    });
    const { states } = deps;

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(states.at(-1)?.status).toBe("transcribing"));

    session.cancelTranscription();
    transcribingToast.resolve();
    await session.done;

    expect(deps.startTranscriber).not.toHaveBeenCalled();
    const cancelled = states.at(-1);
    expect(cancelled).toMatchObject({
      status: "error",
      message: "Transcription cancelled.",
    });
    // The audio was already captured, so cancelling keeps it (#944).
    expect(cancelled?.status === "error" && cancelled.hint).toContain(
      "/tmp/session/dictation.wav",
    );
    expect(deps.cleanupTempDir).not.toHaveBeenCalled();
  });

  it("clears the idle state through the session when speech resumes", async () => {
    let clock = 0;
    let emit!: (patch: RecordingPatch) => void;
    const recorder = deferred<void>();
    const deps = createDeps({
      now: () => clock,
      startRecorder: vi.fn(() => ({ done: recorder.promise, stop: vi.fn() })),
      startRecordingMonitor: vi.fn((onPatch) => {
        emit = onPatch;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startRecorder).toHaveBeenCalled());

    emit({ signal: emptySignal("listening") });
    clock = 30_000;
    emit({ signal: emptySignal("listening") });
    expect(deps.current()).toMatchObject({ idle: true });

    clock = 31_000;
    emit({ signal: signalTick() });
    expect(deps.current()).toMatchObject({
      status: "recording",
      idle: false,
      silentForMs: 0,
    });

    session.cancel();
    recorder.resolve();
    await session.done;
  });

  it("auto-stops and transcribes after continuous silence", async () => {
    let clock = 0;
    let emit!: (patch: RecordingPatch) => void;
    const recorder = deferred<void>();
    const recorderStop = vi.fn(() => recorder.resolve());
    const deps = createDeps({
      now: () => clock,
      startRecorder: vi.fn(() => ({
        done: recorder.promise,
        stop: recorderStop,
      })),
      startRecordingMonitor: vi.fn((onPatch) => {
        emit = onPatch;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startRecorder).toHaveBeenCalled());

    emit({ signal: emptySignal("listening") });
    clock = 30_000;
    emit({ signal: emptySignal("listening") });
    expect(deps.current()).toMatchObject({ status: "recording", idle: true });
    expect(recorderStop).not.toHaveBeenCalled();

    clock = 45_000;
    emit({ signal: emptySignal("listening") });
    expect(recorderStop).toHaveBeenCalledTimes(1);

    await session.done;
    expect(deps.startTranscriber).toHaveBeenCalled();
    expect(deps.toasts).toContainEqual({
      style: "animated",
      title: "Stopped after silence.",
    });
  });

  it("warns about mic permission early when the meter never reports a sample, without stopping", async () => {
    let clock = 0;
    let emit!: (patch: RecordingPatch) => void;
    const recorder = deferred<void>();
    const recorderStop = vi.fn();
    const deps = createDeps({
      now: () => clock,
      startRecorder: vi.fn(() => ({
        done: recorder.promise,
        stop: recorderStop,
      })),
      startRecordingMonitor: vi.fn((onPatch) => {
        emit = onPatch;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startRecorder).toHaveBeenCalled());

    const warning = expect.objectContaining({
      style: "failure",
      title: "No signal from the microphone",
    });

    emit({ signal: emptySignal("unavailable") });
    clock = 7_999;
    emit({ signal: emptySignal("unavailable") });
    expect(deps.toasts).not.toContainEqual(warning);

    clock = 8_000;
    emit({ signal: emptySignal("unavailable") });
    expect(deps.toasts).toContainEqual(warning);
    expect(deps.current().status).toBe("recording");
    expect(recorderStop).not.toHaveBeenCalled();

    clock = 9_000;
    emit({ signal: emptySignal("unavailable") });
    expect(
      deps.toasts.filter(
        (t) =>
          (t as { title?: string }).title === "No signal from the microphone",
      ),
    ).toHaveLength(1);

    recorder.resolve();
    await session.done;
    expect(deps.startTranscriber).toHaveBeenCalled();
  });

  it("scales the transcription timeout to the recording length, not a fixed 60 s (#944)", async () => {
    let clock = 0;
    const recorder = deferred<void>();
    const deps = createDeps({
      now: () => clock,
      startRecorder: vi.fn(() => resolvedTask(recorder.promise)),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startRecorder).toHaveBeenCalled());

    clock = 120_000; // 120 s captured before the recorder resolves
    recorder.resolve();
    await session.done;

    // floor 60 s + 120 s * 2 s/s = 300 s, five times the old fixed cap.
    const transcribing = deps.states.find(
      (state) => state.status === "transcribing",
    );
    expect(transcribing).toMatchObject({
      status: "transcribing",
      timeoutSeconds: 300,
    });
    expect(deps.startTranscriber).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("dictation.wav"),
      300_000,
    );
  });

  it("keeps the recording and names it when transcription fails (#944)", async () => {
    const deps = createDeps({
      startTranscriber: vi.fn(() =>
        resolvedTask(
          Promise.reject(
            new Error("kesha transcription timed out after 300 seconds."),
          ),
        ),
      ),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.cleanupTempDir).not.toHaveBeenCalled();
    const last = deps.states.at(-1);
    expect(last).toMatchObject({
      status: "error",
      message: "kesha transcription timed out after 300 seconds.",
    });
    expect(last?.status === "error" && last.hint).toContain(
      "/tmp/session/dictation.wav",
    );
    expect(last?.status === "error" && last.hint).toContain(
      'kesha "/tmp/session/dictation.wav"',
    );
  });

  it("tells the user no speech was detected when the transcript is empty (#943)", async () => {
    const deps = createDeps({
      startTranscriber: vi.fn(() => resolvedTask(Promise.resolve("  \n"))),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.copyToClipboard).not.toHaveBeenCalled();
    expect(deps.states.at(-1)).toMatchObject({
      status: "error",
      message: "No speech was detected in the recording.",
    });
  });

  it("keeps the recording when the user cancels transcription after capture (#944)", async () => {
    const transcriber = deferred<string>();
    const deps = createDeps({
      startTranscriber: vi.fn(() => ({
        done: transcriber.promise,
        stop: vi.fn(() => transcriber.reject(new Error("killed"))),
      })),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.states.at(-1)?.status).toBe("transcribing"));

    session.cancelTranscription();
    await session.done;

    expect(deps.cleanupTempDir).not.toHaveBeenCalled();
    const last = deps.states.at(-1);
    expect(last).toMatchObject({
      status: "error",
      message: "Transcription cancelled.",
    });
    expect(last?.status === "error" && last.hint).toContain(
      'kesha "/tmp/session/dictation.wav"',
    );
  });

  it("prunes stale recordings on session start (#944)", async () => {
    const deps = createDeps();

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.pruneOldRecordings).toHaveBeenCalled();
  });

  it("keeps the recording when the view is dismissed after transcription starts (#944)", async () => {
    const transcriber = deferred<string>();
    const deps = createDeps({
      startTranscriber: vi.fn(() => ({
        done: transcriber.promise,
        stop: vi.fn(() => transcriber.reject(new Error("killed"))),
      })),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.states.at(-1)?.status).toBe("transcribing"));

    session.cancel();
    await session.done;

    expect(deps.cleanupTempDir).not.toHaveBeenCalled();
  });

  it("keeps a finished recording when dismissed during the silence read (#944)", async () => {
    const silence = deferred<boolean>();
    const deps = createDeps({
      isSilentAudio: vi.fn(() => silence.promise),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.isSilentAudio).toHaveBeenCalled());

    // The WAV is already on disk; dismissing mid-read must not delete it.
    session.cancel();
    silence.resolve(false);
    await session.done;

    expect(deps.cleanupTempDir).not.toHaveBeenCalled();
  });

  it("does not warn about no signal once a meter sample has been seen", async () => {
    let clock = 0;
    let emit!: (patch: RecordingPatch) => void;
    const recorder = deferred<void>();
    const recorderStop = vi.fn();
    const deps = createDeps({
      now: () => clock,
      startRecorder: vi.fn(() => ({
        done: recorder.promise,
        stop: recorderStop,
      })),
      startRecordingMonitor: vi.fn((onPatch) => {
        emit = onPatch;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startRecorder).toHaveBeenCalled());

    emit({ signal: signalTick() });
    clock = 9_000;
    emit({ signal: emptySignal("unavailable") });

    expect(recorderStop).not.toHaveBeenCalled();
    expect(deps.toasts).not.toContainEqual(
      expect.objectContaining({ title: "No signal from the microphone" }),
    );
    expect(deps.current().status).toBe("recording");

    session.cancel();
    recorder.resolve();
    await session.done;
  });

  // Each path resolves a different transcript, so the clipboard names the one that ran.
  it("copies the live transcript with no transcription phase in between (#947)", async () => {
    const deps = createDeps({ preflight: livePreflight() });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.copyToClipboard).toHaveBeenCalledWith("live text");
    expect(deps.states.map((state) => state.status)).toEqual([
      "recording",
      "ok",
    ]);
    expect(deps.toasts).not.toContainEqual(
      expect.objectContaining({ title: "Transcribing" }),
    );
    expect(deps.cleanupTempDir).not.toHaveBeenCalled();
  });

  it("keeps the record-then-transcribe path on an engine without record.live", async () => {
    const deps = createDeps({
      preflight: vi.fn(async () => ({
        ok: true,
        cliVersion: "1.29.1",
        features: ["transcribe"],
      })),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.copyToClipboard).toHaveBeenCalledWith("hello world");
    expect(deps.states.map((state) => state.status)).toEqual([
      "recording",
      "transcribing",
      "ok",
    ]);
  });

  it("keeps the record-then-transcribe path when the CLI is too old to report features", async () => {
    const deps = createDeps();

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.copyToClipboard).toHaveBeenCalledWith("hello world");
    expect(deps.states.some((state) => state.status === "transcribing")).toBe(
      true,
    );
  });

  it("keeps the record-then-transcribe path when the CLI is too old for the flag (#947)", async () => {
    // The engine advertising record.live says nothing about the CLI that spawns it.
    const deps = createDeps({
      preflight: vi.fn(async () => ({
        ok: true,
        cliVersion: "1.27.0",
        features: ["transcribe", "record.live"],
      })),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.copyToClipboard).toHaveBeenCalledWith("hello world");
    expect(deps.states.some((state) => state.status === "transcribing")).toBe(
      true,
    );
  });

  it("does not claim to record while the live engine is still warming up (#947)", async () => {
    const micOpen = deferred<"listening" | "ended">();
    const live = deferred<string>();
    let meterStarted = false;
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() =>
        liveTask(live.promise, { micOpen: micOpen.promise }),
      ),
      startRecordingMonitor: vi.fn(() => {
        meterStarted = true;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startLiveRecorder).toHaveBeenCalled());
    await flushPromises();

    expect(deps.current().status).toBe("starting");
    expect(meterStarted).toBe(false);
    expect(deps.toasts).not.toContainEqual(
      expect.objectContaining({ title: "Recording" }),
    );

    micOpen.resolve("listening");
    await waitFor(() => expect(deps.current().status).toBe("recording"));
    expect(meterStarted).toBe(true);

    live.resolve("warm words\n");
    await session.done;
    expect(deps.copyToClipboard).toHaveBeenCalledWith("warm words");
  });

  it("never opens the meter when the view is dismissed during the live warmup", async () => {
    const micOpen = deferred<"listening" | "ended">();
    const live = deferred<string>();
    let meterStarted = false;
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() =>
        liveTask(live.promise, { micOpen: micOpen.promise }),
      ),
      startRecordingMonitor: vi.fn(() => {
        meterStarted = true;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startLiveRecorder).toHaveBeenCalled());

    session.cancel();
    micOpen.resolve("listening");
    live.resolve("discarded\n");
    await session.done;

    expect(meterStarted).toBe(false);
    expect(deps.current().status).toBe("starting");
    expect(deps.copyToClipboard).not.toHaveBeenCalled();
  });

  it("never shows a recording view for a live session that died before the mic opened (#947)", async () => {
    let meterStarted = false;
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() =>
        liveTask(
          Promise.reject(
            new Error(
              "E_UNSUPPORTED_PLATFORM: live transcription requires a CoreML engine",
            ),
          ),
          { micOpen: Promise.resolve("ended" as const) },
        ),
      ),
      startRecordingMonitor: vi.fn(() => {
        meterStarted = true;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(meterStarted).toBe(false);
    expect(deps.states.map((state) => state.status)).toEqual(["error"]);
    expect(deps.toasts).not.toContainEqual(
      expect.objectContaining({ title: "Recording" }),
    );
    expect(deps.states.at(-1)).toMatchObject({
      status: "error",
      message:
        "E_UNSUPPORTED_PLATFORM: live transcription requires a CoreML engine",
    });
  });

  it("copies nothing when a dismissal lands before a late live transcript", async () => {
    const live = deferred<string>();
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() =>
        liveTask(live.promise, { micOpen: Promise.resolve("ended" as const) }),
      ),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startLiveRecorder).toHaveBeenCalled());

    session.cancel();
    live.resolve("late text\n");
    await session.done;

    expect(deps.copyToClipboard).not.toHaveBeenCalled();
  });

  // A clipboard write handed to the OS cannot be recalled: it stays, the UI does not.
  it("keeps a transcript whose copy was already in flight when the view was dismissed", async () => {
    const copy = deferred<void>();
    const copied: string[] = [];
    let session: DictationSession;
    const deps = createDeps({
      preflight: livePreflight(),
      copyToClipboard: vi.fn(async (text: string) => {
        session.cancel();
        await copy.promise;
        copied.push(text);
      }),
    });

    session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.copyToClipboard).toHaveBeenCalled());
    copy.resolve();
    await session.done;

    expect(copied).toEqual(["live text"]);
    expect(deps.states.some((state) => state.status === "ok")).toBe(false);
    expect(deps.toasts).not.toContainEqual(
      expect.objectContaining({ title: "Copied transcript" }),
    );
  });

  it("does not leave an abandoned live failure unhandled (#947)", async () => {
    const micOpen = deferred<"listening" | "ended">();
    const live = deferred<string>();
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const deps = createDeps({
        preflight: livePreflight(),
        startLiveRecorder: vi.fn(() =>
          liveTask(live.promise, { micOpen: micOpen.promise }),
        ),
      });

      const session = startDictationSession({}, deps.setState, deps);
      await waitFor(() => expect(deps.startLiveRecorder).toHaveBeenCalled());

      session.cancel();
      micOpen.resolve("listening");
      live.reject(new Error("live session died during warmup"));
      await session.done;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("does not deliver a live transcript that arrives after the view was dismissed", async () => {
    const live = deferred<string>();
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() => liveTask(live.promise)),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.current().status).toBe("recording"));

    session.cancel();
    live.resolve("late transcript\n");
    await session.done;

    expect(deps.copyToClipboard).not.toHaveBeenCalled();
    expect(deps.states.some((state) => state.status === "ok")).toBe(false);
  });

  it("releases the microphone at once when a live session is dismissed (#947)", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const kill = vi.fn();
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: (kesha, maxSeconds) =>
        startKeshaLiveRecorder(kesha, maxSeconds, { spawn, kill }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(processes.length).toBe(1));
    processes[0].emitStderr("Listening (48000 Hz)...\n");
    await waitFor(() => expect(deps.current().status).toBe("recording"));

    session.cancel();
    // The stop ladder would leave the device open for another 10 s.
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGTERM");

    processes[0].exit(143);
    processes[0].endStdout();
    await session.done;
  });

  it("reports an early live stop instead of a transcript that never came", async () => {
    const recordingToast = deferred<void>();
    const live = deferred<string>();
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() => liveTask(live.promise)),
      showToast: vi.fn(async (toast) => {
        deps.toasts.push(toast);
        if (toast.title === "Recording") await recordingToast.promise;
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.current().status).toBe("recording"));

    session.stopRecording();
    recordingToast.resolve();
    await session.done;

    expect(deps.copyToClipboard).not.toHaveBeenCalled();
    expect(deps.current()).toMatchObject({
      status: "error",
      message: "Recording stopped before any audio was captured.",
    });
    expect(deps.toasts).not.toContainEqual(
      expect.objectContaining({ title: "Dictation failed" }),
    );
  });

  it("stops a live session and delivers the transcript it produced", async () => {
    const live = deferred<string>();
    const liveStop = vi.fn();
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() => liveTask(live.promise, { stop: liveStop })),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startLiveRecorder).toHaveBeenCalled());

    session.stopRecording();
    expect(deps.states.some((state) => state.status === "stopping")).toBe(true);
    expect(liveStop).toHaveBeenCalled();

    live.resolve("stopped text\n");
    await session.done;

    expect(deps.states.at(-1)).toMatchObject({
      status: "ok",
      result: { text: "stopped text" },
    });
  });

  it("surfaces a failed live session with the CLI's own message", async () => {
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() =>
        liveTask(
          Promise.reject(
            new Error(
              "E_UNSUPPORTED_PLATFORM: live transcription requires a CoreML engine",
            ),
          ),
        ),
      ),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    const last = deps.states.at(-1);
    expect(last).toMatchObject({
      status: "error",
      message:
        "E_UNSUPPORTED_PLATFORM: live transcription requires a CoreML engine",
    });
    // There is no kept recording on the live path, so no path may be named.
    expect(last?.status === "error" && last.hint).toBeUndefined();
    expect(deps.toasts).toContainEqual({
      style: "failure",
      title: "Dictation failed",
    });
  });

  it("still prunes recordings left by earlier sessions on the live path", async () => {
    const deps = createDeps({ preflight: livePreflight() });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.pruneOldRecordings).toHaveBeenCalled();
    expect(deps.cleanupTempDir).not.toHaveBeenCalled();
  });

  it("keeps the meter and idle auto-stop running on the live path", async () => {
    let clock = 0;
    let emit!: (patch: RecordingPatch) => void;
    const live = deferred<string>();
    const liveStop = vi.fn(() => live.resolve("tail words\n"));
    const deps = createDeps({
      now: () => clock,
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() => liveTask(live.promise, { stop: liveStop })),
      startRecordingMonitor: vi.fn((onPatch) => {
        emit = onPatch;
        return vi.fn();
      }),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await waitFor(() => expect(deps.startLiveRecorder).toHaveBeenCalled());

    emit({ signal: emptySignal("listening") });
    clock = 30_000;
    emit({ signal: emptySignal("listening") });
    expect(deps.current()).toMatchObject({ status: "recording", idle: true });
    expect(liveStop).not.toHaveBeenCalled();

    clock = 45_000;
    emit({ signal: emptySignal("listening") });
    expect(liveStop).toHaveBeenCalledTimes(1);

    await session.done;
    expect(deps.toasts).toContainEqual({
      style: "animated",
      title: "Stopped after silence.",
    });
    expect(deps.states.at(-1)).toMatchObject({
      status: "ok",
      result: { text: "tail words" },
    });
  });

  it("tells a live user to check microphone permission when nothing was transcribed (#947)", async () => {
    const deps = createDeps({
      preflight: livePreflight(),
      startLiveRecorder: vi.fn(() => liveTask(Promise.resolve("   \n"))),
    });

    const session = startDictationSession({}, deps.setState, deps);
    await session.done;

    expect(deps.copyToClipboard).not.toHaveBeenCalled();
    const last = deps.states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.status === "error" && last.message).toContain(
      "No speech was detected",
    );
    expect(last?.status === "error" && last.message).toContain(
      "Microphone permission",
    );
    expect(last?.status === "error" && last.hint).toBeUndefined();
  });

  it("keeps the live empty-transcript message distinct from the fallback's (#947)", () => {
    // Live has no WAV, so it merges the two fallback causes; the fallback keeps both apart.
    expect(() => normalizeLiveTranscript("   \n")).toThrow(
      "Microphone permission",
    );
    expect(() => normalizeTranscribeResult("/tmp/a.wav", "   \n")).toThrow(
      "No speech was detected in the recording.",
    );
    expect(() =>
      normalizeTranscribeResult("/tmp/a.wav", "   \n"),
    ).not.toThrow("Microphone permission");
    expect(normalizeLiveTranscript(" said something \n")).toEqual({
      file: "",
      text: "said something",
    });
  });
});

describe("createSilenceTracker", () => {
  it("treats an unavailable meter as continued silence rather than a reset", () => {
    let clock = 0;
    const onIdleStop = vi.fn();
    const tracker = createSilenceTracker({ now: () => clock, onIdleStop });

    tracker.track({ signal: emptySignal("listening") });
    clock = 20_000;
    expect(tracker.track({ signal: emptySignal("unavailable") })).toMatchObject(
      {
        silentForMs: 20_000,
        idle: false,
      },
    );

    clock = 45_000;
    tracker.track({ signal: emptySignal("unavailable") });
    expect(onIdleStop).toHaveBeenCalledTimes(1);
  });

  it("keeps counting on elapsed ticks after a dead meter's single unavailable patch", () => {
    let clock = 0;
    const onIdleStop = vi.fn();
    const tracker = createSilenceTracker({ now: () => clock, onIdleStop });

    tracker.track({ signal: emptySignal("unavailable") });

    clock = 30_000;
    expect(tracker.track({ elapsedSeconds: 30 })).toMatchObject({
      silentForMs: 30_000,
      idle: true,
    });

    clock = 45_000;
    tracker.track({ elapsedSeconds: 45 });
    expect(onIdleStop).toHaveBeenCalledTimes(1);
  });

  it("stops a meter that hangs without ever reporting a state", () => {
    let clock = 0;
    const onIdleStop = vi.fn();
    const tracker = createSilenceTracker({ now: () => clock, onIdleStop });

    clock = 30_000;
    expect(tracker.track({ elapsedSeconds: 30 })).toMatchObject({
      silentForMs: 30_000,
      idle: true,
    });
    expect(onIdleStop).not.toHaveBeenCalled();

    clock = 45_000;
    tracker.track({ elapsedSeconds: 45 });
    expect(onIdleStop).toHaveBeenCalledTimes(1);
  });

  it("counts silence from recording start, not from the first meter sample", () => {
    let clock = 0;
    const onIdleStop = vi.fn();
    const tracker = createSilenceTracker({ now: () => clock, onIdleStop });

    clock = 20_000;
    expect(tracker.track({ signal: emptySignal("listening") })).toMatchObject({
      silentForMs: 20_000,
    });
  });

  it("accumulates silence across listening ticks and warns at 30s", () => {
    let clock = 0;
    const tracker = createSilenceTracker({
      now: () => clock,
      onIdleStop: vi.fn(),
    });

    expect(tracker.track({ signal: emptySignal("listening") })).toMatchObject({
      silentForMs: 0,
      idle: false,
    });
    clock = 29_999;
    expect(tracker.track({ signal: emptySignal("listening") })).toMatchObject({
      idle: false,
    });
    clock = 30_000;
    expect(tracker.track({ signal: emptySignal("listening") })).toMatchObject({
      silentForMs: 30_000,
      idle: true,
    });
  });

  it("fires the idle stop once at the grace ceiling", () => {
    let clock = 0;
    const onIdleStop = vi.fn();
    const tracker = createSilenceTracker({ now: () => clock, onIdleStop });

    tracker.track({ signal: emptySignal("listening") });
    clock = 45_000;
    tracker.track({ signal: emptySignal("listening") });
    clock = 60_000;
    tracker.track({ signal: emptySignal("listening") });

    expect(onIdleStop).toHaveBeenCalledTimes(1);
  });

  it("resets the silence timer on a signal tick", () => {
    let clock = 0;
    const onIdleStop = vi.fn();
    const tracker = createSilenceTracker({ now: () => clock, onIdleStop });

    tracker.track({ signal: emptySignal("listening") });
    clock = 44_000;
    expect(tracker.track({ signal: signalTick() })).toMatchObject({
      silentForMs: 0,
      idle: false,
    });
    clock = 60_000;
    expect(tracker.track({ signal: emptySignal("listening") })).toMatchObject({
      silentForMs: 16_000,
      idle: false,
    });
    expect(onIdleStop).not.toHaveBeenCalled();
  });

  it("measures non-signal patches from the last confirmed speech", () => {
    let clock = 0;
    const tracker = createSilenceTracker({
      now: () => clock,
      onIdleStop: vi.fn(),
    });
    tracker.track({ signal: signalTick() });
    clock = 5_000;
    expect(tracker.track({ elapsedSeconds: 5 })).toMatchObject({
      elapsedSeconds: 5,
      silentForMs: 5_000,
    });
  });

  it("does not accumulate silence while the meter is still starting", () => {
    const tracker = createSilenceTracker({ onIdleStop: vi.fn() });
    expect(tracker.track({ signal: emptySignal("starting") })).toMatchObject({
      silentForMs: 0,
      idle: false,
    });
  });
});

describe("staleRecordingDirs", () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = 1_000_000_000_000;

  it("selects only dictation temp dirs older than a week (#944)", () => {
    const entries = [
      { name: "raycast-kesha-dictate-old", mtimeMs: now - WEEK_MS - 1 },
      { name: "raycast-kesha-dictate-fresh", mtimeMs: now - 1_000 },
      { name: "some-other-temp-dir", mtimeMs: now - WEEK_MS - 10_000 },
    ];
    expect(staleRecordingDirs(entries, now)).toEqual([
      "raycast-kesha-dictate-old",
    ]);
  });

  it("keeps a dictation temp dir exactly at the age boundary", () => {
    const entries = [
      { name: "raycast-kesha-dictate-edge", mtimeMs: now - WEEK_MS },
    ];
    expect(staleRecordingDirs(entries, now)).toEqual([]);
  });
});

describe("pruneOldRecordings", () => {
  const now = 2_000_000_000_000;

  it("removes week-old dictation temps and spares fresh and unrelated ones (#944)", async () => {
    const removed: string[] = [];
    await pruneOldRecordings({
      baseDir: "/tmp",
      now: () => now,
      readdir: async () => [
        "raycast-kesha-dictate-old",
        "raycast-kesha-dictate-fresh",
        "unrelated-dir",
      ],
      stat: async (path) => ({
        mtimeMs: path.includes("old")
          ? now - 8 * 24 * 60 * 60 * 1000
          : now - 60_000,
      }),
      rm: async (path) => {
        removed.push(path);
      },
    });
    expect(removed).toEqual(["/tmp/raycast-kesha-dictate-old"]);
  });

  it("swallows a readdir failure instead of throwing", async () => {
    await expect(
      pruneOldRecordings({
        readdir: async () => {
          throw new Error("EACCES");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("normalizeTranscribeResult", () => {
  it("trims plain kesha stdout and rejects empty transcripts", () => {
    expect(normalizeTranscribeResult("/tmp/a.wav", " hello \n")).toEqual({
      file: "/tmp/a.wav",
      text: "hello",
    });
    expect(() => normalizeTranscribeResult("/tmp/a.wav", " \n")).toThrow(
      "No speech was detected in the recording.",
    );
  });
});

describe("startTranscribingTimer", () => {
  it("updates elapsed seconds only while state is transcribing", () => {
    vi.useFakeTimers();
    let now = 1_000;
    let state: DictationState = {
      status: "transcribing",
      elapsedSeconds: 0,
      timeoutSeconds: 60,
    };
    const states: DictationState[] = [];

    const stop = startTranscribingTimer(
      (next) => {
        state = typeof next === "function" ? next(state) : next;
        states.push(state);
      },
      { now: () => now },
    );

    now = 3_400;
    vi.advanceTimersByTime(500);
    expect(states.at(-1)).toMatchObject({
      status: "transcribing",
      elapsedSeconds: 2,
    });

    state = { status: "starting" };
    now = 8_000;
    vi.advanceTimersByTime(500);
    expect(states.at(-1)).toEqual({ status: "starting" });

    stop();
    vi.useRealTimers();
  });
});

function createDeps(
  overrides: Partial<DictationControllerDeps> = {},
): DictationControllerDeps & {
  setState: (
    next: DictationState | ((state: DictationState) => DictationState),
  ) => void;
  states: DictationState[];
  current: () => DictationState;
  toasts: unknown[];
} {
  let current: DictationState = { status: "starting" };
  const states: DictationState[] = [];
  const toasts: unknown[] = [];
  const deps: DictationControllerDeps = {
    resolveKesha: vi.fn(async () => ({ command: "kesha", prefixArgs: [] })),
    preflight: vi.fn(async () => ({ ok: true })),
    createTempDir: vi.fn(async () => "/tmp/session"),
    cleanupTempDir: vi.fn(async () => undefined),
    startRecordingMonitor: vi.fn(() => vi.fn()),
    startRecorder: vi.fn(() => resolvedTask(Promise.resolve())),
    startLiveRecorder: vi.fn(() => liveTask(Promise.resolve(" live text\n"))),
    startTranscriber: vi.fn(() =>
      resolvedTask(Promise.resolve(" hello world\n")),
    ),
    isSilentAudio: vi.fn(async () => false),
    pruneOldRecordings: vi.fn(async () => undefined),
    copyToClipboard: vi.fn(async () => undefined),
    showToast: vi.fn(async (toast) => {
      toasts.push(toast);
    }),
    ...overrides,
  };
  return {
    ...deps,
    setState: (next) => {
      current = typeof next === "function" ? next(current) : next;
      states.push(current);
    },
    states,
    current: () => current,
    toasts,
  };
}

function livePreflight() {
  return vi.fn(async () => ({
    ok: true,
    cliVersion: "1.29.1",
    features: ["transcribe", "record.live"],
  }));
}

function resolvedTask<T>(done: Promise<T>): RunningTask<T> {
  return { done, stop: vi.fn() };
}

function liveTask(
  done: Promise<string>,
  overrides: Partial<LiveRecorderTask> = {},
): LiveRecorderTask {
  return {
    done,
    micOpen: Promise.resolve("listening" as const),
    stop: vi.fn(),
    abort: vi.fn(),
    ...overrides,
  };
}

function signalTick(): SignalLevel {
  return { rms: 0.02, peak: 0.05, percent: 24, state: "signal" };
}
