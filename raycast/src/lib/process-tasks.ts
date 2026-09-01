import { spawn as defaultSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { KeshaSpawn } from "./kesha-bin";
import type {
  LiveMicOutcome,
  LiveRecorderTask,
  RunningTask,
} from "./dictation-types";
import {
  LIVE_FORCE_KILL_MS,
  LIVE_STDOUT_FLUSH_MS,
  LIVE_STOP_GRACE_MS,
} from "./dictation-config";

type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ProcessTaskDeps {
  spawn?: SpawnFn;
  kill?: (proc: ChildProcess, signal: NodeJS.Signals) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export function capTail(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

export function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals) {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to killing the wrapper if the process group is unavailable.
    }
  }
  proc.kill(signal);
}

function stopWithLadder(
  proc: ChildProcess | null,
  deps: ProcessTaskDeps,
  termMs: number,
  killMs: number,
) {
  if (!proc) return;
  const kill = deps.kill ?? killProcessGroup;
  const schedule = deps.setTimeout ?? setTimeout;
  if (proc.stdin && !proc.stdin.destroyed) {
    try {
      proc.stdin.end("\n");
    } catch {
      // Fall through to the watchdog below.
    }
  }

  schedule(() => {
    if (proc.exitCode == null) kill(proc, "SIGTERM");
  }, termMs).unref?.();

  schedule(() => {
    if (proc.exitCode == null) kill(proc, "SIGKILL");
  }, killMs).unref?.();
}

export function stopProcessWithWatchdog(
  proc: ChildProcess | null,
  deps: ProcessTaskDeps = {},
) {
  stopWithLadder(proc, deps, 1500, 5000);
}

export function stopLiveProcessWithWatchdog(
  proc: ChildProcess | null,
  deps: ProcessTaskDeps = {},
) {
  stopWithLadder(proc, deps, LIVE_STOP_GRACE_MS, LIVE_FORCE_KILL_MS);
}

export function terminateProcessWithWatchdog(
  proc: ChildProcess | null,
  deps: ProcessTaskDeps = {},
) {
  if (!proc) return;
  const kill = deps.kill ?? killProcessGroup;
  const schedule = deps.setTimeout ?? setTimeout;
  if (proc.exitCode == null) kill(proc, "SIGTERM");
  schedule(() => {
    if (proc.exitCode == null) kill(proc, "SIGKILL");
  }, 3000).unref?.();
}

export function startKeshaRecorder(
  kesha: KeshaSpawn,
  audioPath: string,
  maxSeconds: number,
  deps: ProcessTaskDeps = {},
): RunningTask<void> {
  const spawn = deps.spawn ?? defaultSpawn;
  const proc = spawn(
    kesha.command,
    [
      ...kesha.prefixArgs,
      "record",
      "--out",
      audioPath,
      "--max-seconds",
      String(maxSeconds),
    ],
    { stdio: ["pipe", "ignore", "pipe"], detached: true },
  );
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = capTail(stderr + chunk.toString("utf8"), 8000);
  });

  return {
    stop: () => stopProcessWithWatchdog(proc, deps),
    done: waitForExit(proc).then((exitCode) => {
      if (exitCode !== 0) {
        throw new Error(
          stderr.trim() || `kesha record exited with code ${exitCode}`,
        );
      }
    }),
  };
}

// A live session prints its transcript and then exits 128+signal, so a signalled stop succeeded (#962).
const LIVE_SUCCESS_EXIT_CODES = new Set([0, 130, 143]);

// The engine opens the device only after streaming ASR is up, ~20 s on a first run (rust/src/record.rs).
const LIVE_LISTENING_MARKER = "Listening (";

// The engine repaints one progress line per second with \r; keeping every fragment buries the real error (#947).
function renderCarriageReturns(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

export function startKeshaLiveRecorder(
  kesha: KeshaSpawn,
  maxSeconds: number,
  deps: ProcessTaskDeps = {},
): LiveRecorderTask {
  const spawn = deps.spawn ?? defaultSpawn;
  const schedule = deps.setTimeout ?? setTimeout;
  const proc = spawn(
    kesha.command,
    [
      ...kesha.prefixArgs,
      "record",
      "--live",
      "--max-seconds",
      String(maxSeconds),
    ],
    { stdio: ["pipe", "pipe", "pipe"], detached: true },
  );

  let stdout = "";
  let stderr = "";
  let reportMicOpen: (outcome: LiveMicOutcome) => void = () => {};
  const micOpen = new Promise<LiveMicOutcome>((resolve) => {
    reportMicOpen = resolve;
  });
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout = capTail(stdout + chunk.toString("utf8"), 16 * 1024 * 1024);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = capTail(stderr + chunk.toString("utf8"), 8000);
    if (stderr.includes(LIVE_LISTENING_MARKER)) reportMicOpen("listening");
  });
  proc.once("exit", () => reportMicOpen("ended"));
  proc.once("error", () => reportMicOpen("ended"));

  const stdoutEnded = new Promise<void>((resolve) => {
    if (!proc.stdout) {
      resolve();
      return;
    }
    proc.stdout.once("end", () => resolve());
  });

  return {
    micOpen,
    stop: () => stopLiveProcessWithWatchdog(proc, deps),
    abort: () => terminateProcessWithWatchdog(proc, deps),
    done: waitForExit(proc).then(async (exitCode) => {
      // The engine writes the transcript to the CLI's inherited stdout, so it can still be in flight at exit.
      await Promise.race([
        stdoutEnded,
        new Promise<void>((resolve) => {
          schedule(resolve, LIVE_STDOUT_FLUSH_MS).unref?.();
        }),
      ]);
      if (!LIVE_SUCCESS_EXIT_CODES.has(exitCode ?? -1)) {
        throw new Error(
          renderCarriageReturns(stderr).trim() ||
            `kesha record --live exited with code ${exitCode}`,
        );
      }
      return stdout;
    }),
  };
}

export function startKeshaTranscriber(
  kesha: KeshaSpawn,
  audioPath: string,
  timeoutMs: number,
  deps: ProcessTaskDeps = {},
): RunningTask<string> {
  const spawn = deps.spawn ?? defaultSpawn;
  const kill = deps.kill ?? killProcessGroup;
  const schedule = deps.setTimeout ?? setTimeout;
  const unschedule = deps.clearTimeout ?? clearTimeout;
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  const proc = spawn(kesha.command, [...kesha.prefixArgs, audioPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout = capTail(stdout + chunk.toString("utf8"), 16 * 1024 * 1024);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = capTail(stderr + chunk.toString("utf8"), 8000);
  });

  const timeout = schedule(() => {
    timedOut = true;
    kill(proc, "SIGTERM");
  }, timeoutMs);
  timeout.unref?.();

  const forceKill = schedule(() => {
    if (proc.exitCode == null) kill(proc, "SIGKILL");
  }, timeoutMs + 3000);
  forceKill.unref?.();

  return {
    stop: () => terminateProcessWithWatchdog(proc, deps),
    done: waitForExit(proc)
      .then((exitCode) => {
        if (timedOut) {
          throw new Error(
            `kesha transcription timed out after ${timeoutSeconds} seconds.`,
          );
        }
        if (exitCode !== 0) {
          throw new Error(
            stderr.trim() || `kesha exited with code ${exitCode}`,
          );
        }
        return stdout;
      })
      .finally(() => {
        unschedule(timeout);
        unschedule(forceKill);
      }),
  };
}

function waitForExit(proc: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => resolve(code));
  });
}
