type ManagedSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

interface KillableProcess {
  pid: number;
  kill(signal?: ManagedSignal): void;
}

interface ActiveProcess {
  pid: number;
  kill(signal?: ManagedSignal): void;
}

const FORCE_KILL_GRACE_MS = 1_000;
const activeProcesses = new Set<ActiveProcess>();
let signalHandlersInstalled = false;

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

function scheduleForceKill(proc: ActiveProcess): Timer {
  const timer = setTimeout(() => proc.kill("SIGKILL"), FORCE_KILL_GRACE_MS);
  timer.unref?.();
  return timer;
}

function ensureSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("SIGINT", () => terminateActiveProcessTrees("SIGINT", 130));
  process.on("SIGTERM", () => terminateActiveProcessTrees("SIGTERM", 143));
}

function terminateActiveProcessTrees(signal: ManagedSignal, exitCode: number): void {
  for (const proc of activeProcesses) {
    proc.kill(signal);
    scheduleForceKill(proc);
  }
  const timer = setTimeout(() => process.exit(exitCode), 50);
  timer.unref?.();
}
