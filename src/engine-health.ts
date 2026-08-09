import { existsSync } from "fs";
import { errorMessage } from "./error-utils";
import { getEngineBinPath, getEngineCapabilities, type EngineCapabilities } from "./engine";

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

export type EngineFunctionalHealth =
  | { status: "ok"; capabilities: EngineCapabilities }
  | { status: "missing" }
  | { status: "unusable"; detail: string }
  | { status: "mute"; detail: string };

export const CORRUPT_STATE = "installed but not executable (corrupt) - re-run `kesha install`";
export const NOT_FUNCTIONAL_STATE =
  "installed but not functional (reports no capabilities) - re-run `kesha install`";
const MUTE_DETAIL = "reports no capabilities";

/**
 * The single "does this engine describe itself" verdict — doctor, status and the install
 * cache-validity check all consult it so they cannot disagree (#801).
 *
 * Spawning is not working: the #796 stub was `#!/bin/sh\nexit 0`, which passes
 * `probeExecutable` and answers nothing. `mute` is that engine, and it is a fault of the
 * same severity as `unusable`; only `missing` is not a fault, because an absent engine is
 * already reported loudly everywhere (#770).
 */
export async function engineFunctionalHealth(): Promise<EngineFunctionalHealth> {
  try {
    const capabilities = await getEngineCapabilities();
    if (capabilities) return { status: "ok", capabilities };
  } catch {
    // Nothing is swallowed: only an engine that cannot be spawned throws here, and the
    // probe below reports that as `unusable` with the loader's own reason.
  }
  const executable = await probeExecutable(getEngineBinPath(), ["--version"]);
  if (executable.status !== "ok") return executable;
  return { status: "mute", detail: MUTE_DETAIL };
}
