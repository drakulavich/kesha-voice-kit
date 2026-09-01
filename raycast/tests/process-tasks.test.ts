import { describe, expect, it, vi } from "vitest";
import {
  capTail,
  startKeshaLiveRecorder,
  startKeshaRecorder,
  startKeshaTranscriber,
  stopProcessWithWatchdog,
} from "../src/lib/process-tasks";
import { FakeProcess, createSpawnRecorder } from "./helpers/fake-process";
import { flushPromises } from "./helpers/async";

const TIMEOUT_MS = 90_000;

const kesha = { command: "kesha", prefixArgs: ["--prefix"] };

describe("process task helpers", () => {
  it("caps captured output to the tail", () => {
    expect(capTail("abcdef", 3)).toBe("def");
    expect(capTail("ab", 3)).toBe("ab");
  });

  it("starts recorder with plain record args and surfaces stderr on failure", async () => {
    const { spawn, calls, processes } = createSpawnRecorder();
    const task = startKeshaRecorder(kesha, "/tmp/audio.wav", 12, { spawn });

    expect(calls[0]).toMatchObject({
      command: "kesha",
      args: [
        "--prefix",
        "record",
        "--out",
        "/tmp/audio.wav",
        "--max-seconds",
        "12",
      ],
      options: { detached: true },
    });

    processes[0].emitStderr("microphone denied");
    processes[0].exit(2);
    await expect(task.done).rejects.toThrow("microphone denied");
  });

  it("stops recorder with stdin newline, SIGTERM watchdog, and SIGKILL watchdog", () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const kill = vi.fn();

    stopProcessWithWatchdog(proc.asChild(), { kill });

    expect(proc.stdin?.end).toHaveBeenCalledWith("\n");
    vi.advanceTimersByTime(1500);
    expect(kill).toHaveBeenCalledWith(proc.asChild(), "SIGTERM");
    vi.advanceTimersByTime(3500);
    expect(kill).toHaveBeenCalledWith(proc.asChild(), "SIGKILL");
    vi.useRealTimers();
  });

  it("runs plain transcribe, trims nothing in task, and resolves stdout", async () => {
    const { spawn, calls, processes } = createSpawnRecorder();
    const task = startKeshaTranscriber(kesha, "/tmp/audio.wav", TIMEOUT_MS, {
      spawn,
    });

    expect(calls[0]).toMatchObject({
      command: "kesha",
      args: ["--prefix", "/tmp/audio.wav"],
      options: { detached: true },
    });

    processes[0].emitStdout(" hello \n");
    processes[0].exit(0);
    await expect(task.done).resolves.toBe(" hello \n");
  });

  it("kills transcribe on the passed timeout and reports its duration in seconds", async () => {
    vi.useFakeTimers();
    const { spawn, processes } = createSpawnRecorder();
    const kill = vi.fn();
    const task = startKeshaTranscriber(kesha, "/tmp/audio.wav", TIMEOUT_MS, {
      spawn,
      kill,
    });

    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGTERM");
    processes[0].exit(null);
    await expect(task.done).rejects.toThrow(
      "kesha transcription timed out after 90 seconds.",
    );
    vi.useRealTimers();
  });

  it("can stop an active transcribe task", () => {
    const { spawn, processes } = createSpawnRecorder();
    const kill = vi.fn();
    const task = startKeshaTranscriber(kesha, "/tmp/audio.wav", TIMEOUT_MS, {
      spawn,
      kill,
    });

    task.stop();

    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGTERM");
  });

  it("surfaces stderr when transcribe exits nonzero", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaTranscriber(kesha, "/tmp/audio.wav", TIMEOUT_MS, {
      spawn,
    });
    processes[0].emitStderr("bad audio");
    processes[0].exit(1);
    await expect(task.done).rejects.toThrow("bad audio");
  });

  it("asks the CLI to transcribe live and never for a file (#947)", () => {
    const { spawn, calls } = createSpawnRecorder();
    startKeshaLiveRecorder(kesha, 30, { spawn });

    const { command, args, options } = calls[0];
    expect(command).toBe("kesha");
    // A bun-installed CLI is spawned as `bun <resolved kesha>`: no prefix, no live session.
    expect(args[0]).toBe("--prefix");
    expect(args).toContain("record");
    expect(args).toContain("--live");
    expect(args).not.toContain("--out");
    expect(options).toMatchObject({ detached: true });
  });

  it("can still be stopped cooperatively after a live spawn", () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn, kill: vi.fn() });

    task.stop();

    expect(processes[0].stdin?.end).toHaveBeenCalledWith("\n");
  });

  it("resolves the transcript printed when the live session ends", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });

    processes[0].emitStdout("hello world\n");
    processes[0].exit(0);
    processes[0].endStdout();

    await expect(task.done).resolves.toBe("hello world\n");
  });

  it("treats a signalled live session that delivered its transcript as a success (#962)", async () => {
    for (const code of [130, 143]) {
      const { spawn, processes } = createSpawnRecorder();
      const task = startKeshaLiveRecorder(kesha, 30, { spawn });

      processes[0].emitStdout("kept text\n");
      processes[0].exit(code);
      processes[0].endStdout();

      await expect(task.done).resolves.toBe("kept text\n");
    }
  });

  it("surfaces the CLI's stderr on a real failure", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });

    processes[0].emitStderr(
      "E_UNSUPPORTED_PLATFORM: live transcription requires a CoreML engine",
    );
    processes[0].exit(1);
    processes[0].endStdout();

    await expect(task.done).rejects.toThrow("E_UNSUPPORTED_PLATFORM");
  });

  it("keeps a transcript written after the child exit event", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });

    // The engine inherits the CLI's stdout, so it can outlive the wrapper's exit.
    processes[0].exit(0);
    await flushPromises();
    processes[0].emitStdout("late transcript\n");
    processes[0].endStdout();

    await expect(task.done).resolves.toBe("late transcript\n");
  });

  it("gives up on stdout that never ends", async () => {
    vi.useFakeTimers();
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });

    processes[0].emitStdout("partial\n");
    processes[0].exit(0);
    await flushPromises();
    vi.advanceTimersByTime(2_000);

    await expect(task.done).resolves.toBe("partial\n");
    vi.useRealTimers();
  });

  it("keeps waiting for a transcript through the flush window", async () => {
    vi.useFakeTimers();
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });
    let settled = false;
    void task.done.then(() => {
      settled = true;
    });

    processes[0].exit(0);
    await flushPromises();
    vi.advanceTimersByTime(1_999);
    await flushPromises();
    expect(settled).toBe(false);

    processes[0].emitStdout("slow transcript\n");
    processes[0].endStdout();

    await expect(task.done).resolves.toBe("slow transcript\n");
    vi.useRealTimers();
  });

  it("finishes a live session without a stdout pipe without waiting out the flush window", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess({ stdio: ["pipe", "ignore", "pipe"] });
    const task = startKeshaLiveRecorder(kesha, 30, {
      spawn: () => proc.asChild(),
    });
    let settled = false;
    void task.done.then(() => {
      settled = true;
    });

    proc.exit(0);
    await flushPromises();
    await flushPromises();

    // Nothing has advanced the clock, so only the guard can have settled this.
    expect(settled).toBe(true);
    await expect(task.done).resolves.toBe("");
    vi.useRealTimers();
  });

  it("does not bury a live failure under the engine's progress ticker (#947)", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 300, { spawn });

    processes[0].emitStderr(
      "Preparing streaming ASR (first run compiles models for the ANE, ~20 s)...\n",
    );
    processes[0].emitStderr(
      "Listening (48000 Hz)... transcript prints when recording stops; Ctrl-C stops and still prints.\n",
    );
    for (let second = 1; second <= 300; second++) {
      processes[0].emitStderr(`\rListening... ${second}s`);
    }
    processes[0].emitStderr(
      "\nerror [E_INTERNAL]: streaming session failed to finish\n",
    );
    processes[0].exit(1);
    processes[0].endStdout();

    const message = await task.done.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    expect(message).toContain(
      "error [E_INTERNAL]: streaming session failed to finish",
    );
    expect(message).not.toContain("Listening... 42s");
    expect(message.length).toBeLessThan(400);
  });

  it("keeps a multi-line live error intact, blank line and hint included", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });

    processes[0].emitStderr(
      "Error: VAD model not installed\n\nPlease run: kesha install --vad\n",
    );
    processes[0].exit(1);
    processes[0].endStdout();

    const message = await task.done.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    expect(message).toBe(
      "Error: VAD model not installed\n\nPlease run: kesha install --vad",
    );
  });

  it("reports the microphone open only once the engine is listening (#947)", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });
    let opened: string | null = null;
    void task.micOpen.then((outcome) => {
      opened = outcome;
    });

    processes[0].emitStderr(
      "Preparing streaming ASR (first run compiles models for the ANE, ~20 s)...\n",
    );
    await flushPromises();
    expect(opened).toBeNull();

    processes[0].emitStderr("Listening (48000 Hz)... transcript prints when ");
    await flushPromises();
    expect(opened).toBe("listening");
  });

  it("stops waiting for the microphone when the live session dies first", async () => {
    const { spawn, processes } = createSpawnRecorder();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn });

    processes[0].emitStderr("E_UNSUPPORTED_PLATFORM\n");
    processes[0].exit(1);
    processes[0].endStdout();

    await expect(task.micOpen).resolves.toBe("ended");
    await expect(task.done).rejects.toThrow("E_UNSUPPORTED_PLATFORM");
  });

  it("releases the microphone at once when a live session is abandoned (#947)", () => {
    vi.useFakeTimers();
    const { spawn, processes } = createSpawnRecorder();
    const kill = vi.fn();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn, kill });

    task.abort();
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGTERM");

    vi.advanceTimersByTime(2_999);
    expect(kill).not.toHaveBeenCalledWith(processes[0].asChild(), "SIGKILL");
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGKILL");
    vi.useRealTimers();
  });

  it("does not signal a live session that is still finalising its transcript", () => {
    vi.useFakeTimers();
    const { spawn, processes } = createSpawnRecorder();
    const kill = vi.fn();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn, kill });

    task.stop();
    expect(processes[0].stdin?.end).toHaveBeenCalledWith("\n");

    vi.advanceTimersByTime(9_999);
    expect(kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(processes[0].asChild(), "SIGKILL");

    vi.advanceTimersByTime(4_999);
    expect(kill).not.toHaveBeenCalledWith(processes[0].asChild(), "SIGKILL");

    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGKILL");
    vi.useRealTimers();
  });
});
