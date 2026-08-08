import { existsSync } from "fs";
import { errorMessage } from "./error-utils";

export type ExecutableHealth =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "unusable"; detail: string };

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Proves a downloaded binary actually executes — existence is not health (#770).
 *
 * Any exit code counts as healthy: the probe only has to show that the loader accepted the
 * image, and the sidecars legitimately exit non-zero when invoked with no work to do. A
 * truncated download is refused before `main` runs — the spawn throws, or the kernel kills
 * the process outright (SIGKILL on an invalid Mach-O) — and those are what this reports.
 *
 * The timeout guards against a binary that starts but never exits; macOS Gatekeeper can take
 * several seconds to scan a freshly written binary on its first run, so it is generous.
 */
export async function probeExecutable(
  binPath: string,
  args: string[] = [],
): Promise<ExecutableHealth> {
  if (!existsSync(binPath)) return { status: "missing" };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binPath, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (err) {
    return { status: "unusable", detail: errorMessage(err) };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, PROBE_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return { status: "unusable", detail: `no exit within ${PROBE_TIMEOUT_MS / 1000}s` };
  }
  if (proc.signalCode) return { status: "unusable", detail: `killed by ${proc.signalCode}` };
  return { status: "ok" };
}
