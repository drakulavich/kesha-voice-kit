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
      // Nothing this probe runs reads a `KESHA_*` today; it is passed so every engine spawn
      // resolves env the same way and the #874/#876 class cannot come back here (#876).
      env: process.env,
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

/**
 * The version the binary claims for itself (`kesha-engine 1.24.9` → `1.24.9`), or null when it
 * names none — a stand-in engine, or a build predating `--version`.
 *
 * The `.version` marker beside the binary is a claim any other writer can overwrite; the engine
 * is the only witness to which engine is actually on disk (#997).
 */
export async function readExecutableVersion(
  binPath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  if (!existsSync(binPath)) return null;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binPath, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    });
  } catch {
    return null;
  }

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  let stdout: string;
  try {
    [stdout] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(stdout)?.[1] ?? null;
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
 *
 * Capabilities are asked for first, so a healthy engine costs one spawn — and they carry
 * the same deadline as the `--version` probe, because a binary that never answers is one
 * that could not be made to answer (`unusable`), not one that answered nothing (`mute`).
 */
export async function engineFunctionalHealth(
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<EngineFunctionalHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const capabilities = await getEngineCapabilities({ signal: controller.signal });
    if (capabilities) return { status: "ok", capabilities };
  } catch {
    // Nothing is swallowed: an engine that cannot be spawned, or that outlived the
    // deadline, is classified below rather than reported as a bare stack trace.
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) {
    return { status: "unusable", detail: `no exit within ${timeoutMs / 1000}s` };
  }
  const executable = await probeExecutable(getEngineBinPath(), ["--version"]);
  if (executable.status !== "ok") return executable;
  return { status: "mute", detail: MUTE_DETAIL };
}
