import { access, constants, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROBE_TIMEOUT_MS } from "./dictation-config";

const execFileAsync = promisify(execFile);

const FALLBACK_CANDIDATES: ReadonlyArray<string> = [
  join(homedir(), ".bun", "bin", "kesha"),
  "/opt/homebrew/bin/kesha",
  "/usr/local/bin/kesha",
  join(homedir(), ".npm-global", "bin", "kesha"),
  join(homedir(), ".local", "bin", "kesha"),
];

const INTERPRETER_CANDIDATES: ReadonlyArray<string> = [
  join(homedir(), ".bun", "bin", "bun"),
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/local/opt/node/bin/node",
];

export interface KeshaSpawn {
  command: string;
  prefixArgs: string[];
}

export interface KeshaBinDeps {
  candidates?: ReadonlyArray<string>;
  interpreterCandidates?: ReadonlyArray<string>;
  isExecutable?: (path: string) => Promise<boolean>;
  readShebang?: (path: string) => Promise<string | null>;
  realpath?: (path: string) => Promise<string>;
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseShebang(head: Buffer): string | null {
  if (head.length < 2 || head[0] !== 0x23 || head[1] !== 0x21) {
    return null;
  }
  const eol = head.indexOf(0x0a);
  const end = eol > 0 ? eol : head.length;
  return head.subarray(2, end).toString("utf8").trim();
}

async function defaultReadShebang(path: string): Promise<string | null> {
  try {
    const fd = await open(path, "r");
    try {
      const buf = Buffer.alloc(128);
      const { bytesRead } = await fd.read(buf, 0, 128, 0);
      return parseShebang(buf.subarray(0, bytesRead));
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

function withDefaults(deps: KeshaBinDeps): Required<KeshaBinDeps> {
  return {
    candidates: FALLBACK_CANDIDATES,
    interpreterCandidates: INTERPRETER_CANDIDATES,
    isExecutable: defaultIsExecutable,
    readShebang: defaultReadShebang,
    realpath,
    ...deps,
  };
}

async function findInterpreter(
  name: string,
  deps: Required<KeshaBinDeps>,
): Promise<string | null> {
  for (const path of deps.interpreterCandidates) {
    if (path.endsWith(`/${name}`) && (await deps.isExecutable(path))) {
      return path;
    }
  }
  return null;
}

async function buildSpawn(
  path: string,
  deps: Required<KeshaBinDeps>,
): Promise<KeshaSpawn | null> {
  if (!(await deps.isExecutable(path))) {
    return null;
  }
  let resolved = path;
  try {
    resolved = await deps.realpath(path);
  } catch {
    // Keep original path if the symlink target cannot be resolved.
  }
  const shebang = await deps.readShebang(resolved);
  if (!shebang) {
    return { command: path, prefixArgs: [] };
  }
  const envMatch = shebang.match(/^\/usr\/bin\/env\s+([\w.-]+)/);
  if (envMatch) {
    const interp = await findInterpreter(envMatch[1], deps);
    if (interp) {
      return { command: interp, prefixArgs: [resolved] };
    }
  }
  return { command: path, prefixArgs: [] };
}

export async function resolveKeshaBin(
  preference: string | undefined,
  deps: KeshaBinDeps = {},
): Promise<KeshaSpawn | null> {
  const resolved = withDefaults(deps);
  const trimmed = preference?.trim();
  if (trimmed) {
    return buildSpawn(trimmed, resolved);
  }
  for (const candidate of resolved.candidates) {
    const spawn = await buildSpawn(candidate, resolved);
    if (spawn) {
      return spawn;
    }
  }
  return null;
}

export interface ProbeDeps {
  execFile?: (
    command: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface EnginePreflightResult {
  ok: boolean;
  hint?: string;
  /** Why the engine is unusable — lets the setup view name the right remedy (#647). */
  reason?: "missing" | "unusable";
}

const MISSING_ENGINE_MARKER = "not installed";
// A corrupt binary is not repaired by a plain `kesha install`: that hits the
// cached-engine path and only re-trusts it. `--no-cache` forces the re-download
// (`cacheValid = versionMatches && (!noCache || !canWriteEngineDir)`).
const REPAIR_HINT = "Run `kesha install --no-cache` to re-download the engine.";

function runKesha(spawn: KeshaSpawn, args: string[], deps: ProbeDeps) {
  const run = deps.execFile ?? execFileAsync;
  return run(spawn.command, [...spawn.prefixArgs, ...args], {
    timeout: PROBE_TIMEOUT_MS,
  });
}

function parseStatusObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Anchored to the Binary line rather than the whole output: "not installed" is
// `formatStatusLine`'s default missing label, so a future missing line would
// otherwise read as the engine being absent.
function proseSaysEngineMissing(stdout: string): boolean {
  const binaryLine = stdout
    .split("\n")
    .find((line) => line.includes("Binary:"));
  if (binaryLine) return binaryLine.includes(MISSING_ENGINE_MARKER);
  return stdout.includes(MISSING_ENGINE_MARKER);
}

function readStructuredStatus(
  payload: Record<string, unknown>,
): EnginePreflightResult | null {
  const engine = payload.engine;
  if (!engine || typeof engine !== "object") return null;
  const { installed, capabilities } = engine as Record<string, unknown>;
  if (typeof installed !== "boolean") return null;

  if (!installed) {
    const hint = typeof payload.hint === "string" ? payload.hint.trim() : "";
    return { ok: false, reason: "missing", hint: hint || undefined };
  }
  // Present is not usable: a binary that cannot report its capabilities would
  // fail during transcription, after the recording is already gone (#647).
  if (capabilities === null || capabilities === undefined) {
    return { ok: false, reason: "unusable", hint: REPAIR_HINT };
  }
  return { ok: true };
}

/**
 * Decides whether the engine can run before a session starts.
 *
 * Reads `kesha status --json` when the resolved CLI emits it. A CLI too old for
 * that flag prints human text instead (citty ignores unknown flags), which is
 * the signal to fall back to the prose marker — so the fallback is chosen by
 * stdout *kind*, never by parse outcome. Output that is a JSON object but
 * breaks the contract fails closed: it would also miss the prose marker and be
 * reported as healthy. A probe that cannot run at all still fails open, letting
 * the CLI's own guards report the real problem with a better message.
 */
export async function probeEngineAvailability(
  spawn: KeshaSpawn,
  deps: ProbeDeps = {},
): Promise<EnginePreflightResult> {
  try {
    const { stdout, stderr } = await runKesha(
      spawn,
      ["status", "--json"],
      deps,
    );
    const payload = parseStatusObject(stdout);
    if (payload) {
      return (
        readStructuredStatus(payload) ?? {
          ok: false,
          reason: "unusable",
          hint: REPAIR_HINT,
        }
      );
    }
    if (proseSaysEngineMissing(stdout)) {
      return { ok: false, reason: "missing", hint: stderr.trim() || undefined };
    }
    return { ok: true };
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    if (stderr.includes("kesha install"))
      return { ok: false, reason: "missing", hint: stderr };
    return { ok: true };
  }
}

export function notFoundMessage(): string {
  return [
    "kesha CLI not found. Finish setup:",
    "1. Install the CLI — `brew install drakulavich/tap/kesha-voice-kit` (or `bun add -g @drakulavich/kesha-voice-kit`).",
    "2. Run `kesha install` to download the engine and models.",
    `Already installed? Set the "Kesha Binary Path" preference to an absolute path. Probed: ${FALLBACK_CANDIDATES.join(", ")}`,
  ].join("\n");
}
