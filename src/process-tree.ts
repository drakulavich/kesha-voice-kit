import { KeshaError } from "./engine/events";

type ManagedSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
type ReceivedSignal = "SIGINT" | "SIGTERM";

interface KillableProcess {
  pid: number;
  kill(signal?: ManagedSignal): void;
}

interface ActiveProcess {
  pid: number;
  kill(signal?: ManagedSignal): void;
}

const FORCE_KILL_GRACE_MS = 1_000;
const SIGNAL_EXIT_BUFFER_MS = 50;
const activeProcesses = new Set<ActiveProcess>();
let signalHandlersInstalled = false;
let pendingSignalCleanup:
  | {
      signal: ReceivedSignal;
      exitCode: number;
      done: Promise<void>;
    }
  | null = null;

export function engineAbortError(): Error {
  const err = new Error("kesha-engine process aborted");
  err.name = "AbortError";
  return err;
}

export function registerProcessTree(proc: KillableProcess): {
  dispose: () => void;
  terminate: (signal?: ManagedSignal) => void;
  forceKillAfterGrace: () => Timer;
} {
  const active: ActiveProcess = {
    pid: proc.pid,
    kill: (signal?: ManagedSignal) => terminateProcessTree(proc, signal),
  };
  activeProcesses.add(active);
  ensureSignalHandlers();
  return {
    dispose: () => {
      activeProcesses.delete(active);
    },
    terminate: (signal: ManagedSignal = "SIGTERM") => active.kill(signal),
    forceKillAfterGrace: () => scheduleForceKill(active),
  };
}

export function getPendingSignalExitCode(): number | null {
  return pendingSignalCleanup?.exitCode ?? null;
}

export async function waitForPendingSignalCleanup(): Promise<number | null> {
  if (!pendingSignalCleanup) return null;
  await pendingSignalCleanup.done;
  return pendingSignalCleanup.exitCode;
}

/** The `E_INTERRUPTED` failure of a run the CLI's own signal cut short, named after that signal rather than whatever the engine died of; null while no signal has arrived, and null for a run that still exited 0, whose output is whole. */
export function interruptedRun(exitCode: number): KeshaError | null {
  if (exitCode === 0 || !pendingSignalCleanup) return null;
  const { signal, exitCode: signalExitCode } = pendingSignalCleanup;
  return new KeshaError("E_INTERRUPTED", `interrupted (${signal})`, { exitCode: signalExitCode });
}

export function terminateProcessTree(proc: KillableProcess, signal: ManagedSignal = "SIGTERM"): void {
  if (!Number.isFinite(proc.pid) || proc.pid <= 0) {
    safeKillDirect(proc, signal);
    return;
  }

  if (process.platform === "win32") {
    const args = ["/PID", String(proc.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      Bun.spawn(["taskkill", ...args], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    } catch {
      safeKillDirect(proc, signal);
      return;
    }
  }

  try {
    process.kill(-proc.pid, signal);
  } catch {
    safeKillDirect(proc, signal);
  }
}

function safeKillDirect(proc: KillableProcess, signal: ManagedSignal): void {
  try {
    proc.kill(signal);
  } catch {
    // The process may already have exited between the caller deciding to clean
    // it up and the signal reaching the kernel.
  }
}

function scheduleForceKill(proc: ActiveProcess, opts: { ref?: boolean } = {}): Timer {
  const timer = setTimeout(() => proc.kill("SIGKILL"), FORCE_KILL_GRACE_MS);
  if (opts.ref !== true) timer.unref?.();
  return timer;
}

function ensureSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("SIGINT", () => terminateActiveProcessTrees("SIGINT", 130));
  process.on("SIGTERM", () => terminateActiveProcessTrees("SIGTERM", 143));
}

function terminateActiveProcessTrees(signal: ReceivedSignal, exitCode: number): void {
  const processes = [...activeProcesses];

  for (const proc of processes) {
    proc.kill(signal);
    scheduleForceKill(proc, { ref: true });
  }

  // The first signal names the run's outcome; a repeat only re-signals what is still running.
  if (pendingSignalCleanup) {
    return;
  }
  process.exitCode = exitCode;

  const delayMs = processes.length > 0
    ? FORCE_KILL_GRACE_MS + SIGNAL_EXIT_BUFFER_MS
    : SIGNAL_EXIT_BUFFER_MS;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  pendingSignalCleanup = { signal, exitCode, done };
  setTimeout(resolveDone, delayMs);
  done.then(() => process.exit(exitCode));
}
