import { existsSync, statSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { dirSizeBytes } from "./diagnostic-paths";

/** The sidecar executables the engine spawns from its own directory. */
const SIDECAR_FILES = ["say-avspeech", "kesha-textlang"] as const;

export interface CacheComponentSize {
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
}

interface EngineFootprint {
  path: string;
  members: string[];
  sizeOf: (path: string) => number;
}

/**
 * Whether `child` is `parent` itself or lives under it — the one answer `status --disk` and
 * `doctor` both need before deciding whether an engine dir is already inside the cache total.
 * A bare `startsWith` reads the sibling `~/.cache/kesha-alt` as inside `~/.cache/kesha` and
 * drops its size (#790); `KESHA_CACHE_DIR` and `KESHA_ENGINE_BIN` are taken verbatim, so both
 * sides are resolved first.
 */
export function isInsideDir(child: string, parent: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${sep}`);
}

/**
 * What the Engine row owns (#1313). A managed install owns all of `<cache>/engine`. An
 * overridden binary (`KESHA_ENGINE_BIN`, a Nix store path) shares its directory with software
 * Kesha does not own, so only the binary and the sidecars beside it are counted — its
 * grandparent may be `/usr/local`.
 */
function engineFootprint(binPath: string, cacheRoot: string): EngineFootprint {
  const managedRoot = join(cacheRoot, "engine");
  if (resolve(dirname(binPath)) === resolve(managedRoot, "bin")) {
    return { path: managedRoot, members: [managedRoot], sizeOf: dirSizeBytes };
  }
  const binDir = dirname(binPath);
  return {
    path: binPath,
    members: [binPath, ...SIDECAR_FILES.map((f) => join(binDir, f))],
    sizeOf: regularFileBytes,
  };
}

/** A sidecar name that is (or links to) a directory is not ours to walk. */
function regularFileBytes(path: string): number {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function footprintBytes(engine: EngineFootprint, members: string[]): number {
  return members.reduce((n, p) => n + engine.sizeOf(p), 0);
}

/** The cache plus whatever engine bytes live outside it, each counted once (#790). */
export function cacheTotalBytes(cacheRoot: string, binPath: string): number {
  const engine = engineFootprint(binPath, cacheRoot);
  const outside = engine.members.filter((m) => !isInsideDir(m, cacheRoot));
  return dirSizeBytes(cacheRoot) + footprintBytes(engine, outside);
}

/**
 * The Kesha-managed directories both `kesha status --disk` and `kesha doctor` report, in one
 * place so a new model dir cannot be added to only one of them. The two ASR rows are mutually
 * exclusive: a CoreML engine never populates the ONNX dir, and instead roots FluidAudio's own
 * subsystems under `<cache>/fluidaudio`, which is where the relocated bundles land (#688).
 * Whatever stayed in FluidAudio's own trees is outside this cache and is reported separately
 * by `fluidExternalRoots`.
 */
export function cacheComponents(
  cacheRoot: string,
  binPath: string,
  coreml: boolean,
): CacheComponentSize[] {
  const engine = engineFootprint(binPath, cacheRoot);
  const engineRow = {
    label: "Engine",
    path: engine.path,
    exists: existsSync(engine.path),
    sizeBytes: footprintBytes(engine, engine.members),
  };
  const modelRows = [
    ...(coreml
      ? [{ label: "FluidAudio (in cache)", path: join(cacheRoot, "fluidaudio") }]
      : [{ label: "ASR (Parakeet)", path: join(cacheRoot, "models/parakeet-tdt-v3") }]),
    { label: "Language ID", path: join(cacheRoot, "models/lang-id-ecapa") },
    { label: "VAD (Silero)", path: join(cacheRoot, "models/silero-vad") },
    { label: "TTS (Kokoro)", path: join(cacheRoot, "models/kokoro-82m") },
    { label: "TTS (Vosk)", path: join(cacheRoot, "models/vosk-ru") },
  ].map((row) => ({ ...row, exists: existsSync(row.path), sizeBytes: dirSizeBytes(row.path) }));
  return [engineRow, ...modelRows];
}
