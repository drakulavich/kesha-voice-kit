import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { dirSizeBytes } from "./diagnostic-paths";
import { isDarwinArm64 } from "./engine-targets";

export const KOKORO_ONNX_UNUSED_NOTE = "not used on darwin-arm64, where Kokoro runs from the TTS (Kokoro ANE) bundle";

/** The sidecar executables the engine spawns from its own directory. */
const SIDECAR_FILES = ["say-avspeech", "kesha-textlang"] as const;

export interface CacheComponentSize {
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  note?: string;
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
  const realCache = existingPath(cacheRoot);
  const outside = engine.members.filter((m) => !isInsideDir(existingPath(m), realCache));
  return dirSizeBytes(cacheRoot) + footprintBytes(engine, outside);
}

/** Compared by target, so an outside symlink into the cache is not counted twice. */
function existingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
  const coremlRows = [
    { label: "FluidAudio (in cache)", path: join(cacheRoot, "fluidaudio") },
    { label: "Diarization (Sortformer)", path: join(cacheRoot, "models/diarize") },
  ];
  const onnxRows = [
    { label: "ASR (Parakeet)", path: join(cacheRoot, "models/parakeet-tdt-v3") },
    { label: "G2P (CharsiuG2P)", path: join(cacheRoot, "models/g2p") },
  ];
  const [usedRows, unusedRows] = coreml ? [coremlRows, onnxRows] : [onnxRows, coremlRows];
  const sized = (row: { label: string; path: string }) => ({
    ...row,
    exists: existsSync(row.path),
    sizeBytes: dirSizeBytes(row.path),
  });
  const modelRows = [
    ...usedRows,
    { label: "Language ID", path: join(cacheRoot, "models/lang-id-ecapa") },
    { label: "VAD (Silero)", path: join(cacheRoot, "models/silero-vad") },
    {
      label: "TTS (Kokoro)",
      path: join(cacheRoot, "models/kokoro-82m"),
      ...(isDarwinArm64() ? { note: KOKORO_ONNX_UNUSED_NOTE } : {}),
    },
    { label: "TTS (Vosk)", path: join(cacheRoot, "models/vosk-ru") },
  ].map(sized);
  const leftoverRows = unusedRows
    .map((row) => sized({ ...row, label: `${row.label}, unused by this engine, safe to delete` }))
    .filter((row) => row.exists);
  return [engineRow, ...modelRows, ...leftoverRows];
}
