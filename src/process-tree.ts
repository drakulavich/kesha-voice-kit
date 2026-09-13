import { KeshaError } from "./engine/events";

type ManagedSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
type ReceivedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

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
      settle: () => void;
    }
  | null = null;

/** The rejection for a cancelled run; `name` stays `AbortError` so signal-driven callers can keep matching on it. */
export function engineAbortError(): KeshaError {
  const err = new KeshaError("E_INTERRUPTED", "kesha-engine process aborted", {
    exitCode: 130,
    hint: "the caller's AbortSignal was aborted; the engine subprocess was terminated",
  });
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
      if (activeProcesses.size === 0) pendingSignalCleanup?.settle();
    },
    terminate: (signal: ManagedSignal = "SIGTERM") => active.kill(signal),
    forceKillAfterGrace: () => scheduleForceKill(active),
  };
}

/** Terminates `tree` when `signal` fires and arms the force kill; `dispose` detaches the listener once the run is over. */
export function abortOnSignal(
  tree: { terminate: (signal?: ManagedSignal) => void; forceKillAfterGrace: () => Timer },
  signal: AbortSignal | undefined,
): { readonly aborted: boolean; dispose: () => void } {
  let aborted = false;
  let forceKillTimer: Timer | undefined;
  const abort = () => {
    aborted = true;
    tree.terminate("SIGTERM");
    forceKillTimer ??= tree.forceKillAfterGrace();
  };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    get aborted() {
      return aborted;
    },
    dispose: () => signal?.removeEventListener("abort", abort),
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

/** The `E_INTERRUPTED` failure every run refused after the CLI received a signal carries; null while none has arrived. */
export function pendingInterruption(): KeshaError | null {
  if (!pendingSignalCleanup) return null;
  const { signal, exitCode } = pendingSignalCleanup;
  return new KeshaError("E_INTERRUPTED", `interrupted (${signal})`, { exitCode });
}

/** The `E_INTERRUPTED` failure of a run the CLI's own signal cut short, named after that signal rather than whatever the engine died of; null while no signal has arrived, and null for a run that still exited 0, whose output is whole. */
export function interruptedRun(exitCode: number): KeshaError | null {
  return exitCode === 0 ? null : pendingInterruption();
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
  process.on("SIGINT", () => terminateActiveProcessTrees("SIGINT", "SIGINT", 130));
  process.on("SIGTERM", () => terminateActiveProcessTrees("SIGTERM", "SIGTERM", 143));
  // The engine runs detached in its own group, so a terminal hangup only reaches it forwarded; Windows has no hangup to forward.
  if (process.platform !== "win32") process.on("SIGHUP", () => terminateActiveProcessTrees("SIGHUP", "SIGTERM", 129));
}

function terminateActiveProcessTrees(signal: ReceivedSignal, forward: ManagedSignal, exitCode: number): void {
  const processes = [...activeProcesses];

  for (const proc of processes) {
    proc.kill(forward);
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
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  pendingSignalCleanup = { signal, exitCode, done, settle };
  // The backstop for a command that never awaits the cleanup; one that does exits as soon as the tree drains.
  setTimeout(() => {
    settle();
    process.exit(exitCode);
  }, delayMs);
  if (processes.length === 0) settle();
}
