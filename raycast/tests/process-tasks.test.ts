import { describe, expect, it, vi } from "vitest";
import {
  capTail,
  startKeshaLiveRecorder,
  startKeshaRecorder,
  startKeshaTranscriber,
  stopProcessWithWatchdog,
} from "../src/lib/process-tasks";
import {
  LIVE_FORCE_KILL_MS,
  LIVE_STDOUT_FLUSH_MS,
  LIVE_STOP_GRACE_MS,
} from "../src/lib/dictation-config";
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

    expect(proc.stdin.end).toHaveBeenCalledWith("\n");
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
    expect(args).toContain("record");
    expect(args).toContain("--live");
    expect(args).not.toContain("--out");
    expect(args[args.indexOf("--max-seconds") + 1]).toBe("30");
    expect(options).toMatchObject({ detached: true });
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
    vi.advanceTimersByTime(LIVE_STDOUT_FLUSH_MS);

    await expect(task.done).resolves.toBe("partial\n");
    vi.useRealTimers();
  });

  it("does not signal a live session that is still finalising its transcript", () => {
    vi.useFakeTimers();
    const { spawn, processes } = createSpawnRecorder();
    const kill = vi.fn();
    const task = startKeshaLiveRecorder(kesha, 30, { spawn, kill });

    task.stop();
    expect(processes[0].stdin.end).toHaveBeenCalledWith("\n");

    vi.advanceTimersByTime(1500);
    expect(kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LIVE_STOP_GRACE_MS - 1500);
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGTERM");

    vi.advanceTimersByTime(LIVE_FORCE_KILL_MS - LIVE_STOP_GRACE_MS);
    expect(kill).toHaveBeenCalledWith(processes[0].asChild(), "SIGKILL");
    vi.useRealTimers();
  });
});
