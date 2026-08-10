import { readdirSync } from "fs";
import { join } from "path";
import { isInsideDir } from "./cache-layout";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";
import { fluidAsrCacheReady, legacyFluidAsrCachePath } from "./fluid-asr-cache";
import { keshaCacheDir } from "./paths";

export interface FluidRootsOptions {
  homeDir?: string;
  cacheRoot?: string;
}

/** One FluidAudio subsystem's directory, resolved the way the engine resolves it. */
export interface FluidSubsystem {
  label: string;
  path: string;
  /** True when the bytes are already inside the Kesha cache total. */
  inCache: boolean;
}

export interface FluidRootSubsystem {
  label: string;
  path: string;
  sizeBytes: number;
}

/** A FluidAudio tree outside the Kesha cache, and which subsystems the engine still reads from it. */
export interface FluidExternalRoot {
  path: string;
  sizeBytes: number;
  subsystems: FluidRootSubsystem[];
  /** Bytes under the root no resolved subsystem accounts for — FluidAudio's own leftovers. */
  otherBytes: number;
}

/**
 * Mirrors `models.rs::dir_has_entries`. Deliberately weak: a false positive keeps a legacy
 * directory in use, a false negative re-downloads it (#688).
 */
function dirHasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function legacyKokoroAneDir(homeDir: string): string {
  return join(homeDir, ".cache", "fluidaudio", "Models", "kokoro-82m-coreml");
}

/** Upstream pins `G2PModel.shared` to this path, so it is never re-rooted (#688). */
function kokoroG2pDir(homeDir: string): string {
  return join(homeDir, ".cache", "fluidaudio", "Models", "kokoro");
}

function legacySortformerDir(homeDir: string): string {
  return join(homeDir, "Library", "Application Support", "fluidaudio-rs", "SortformerCompiled");
}

/** The three trees FluidAudio picks for itself, in the order `status` and `doctor` report them. */
export function fluidLegacyRootPaths(homeDir = diagnosticHomeDir()): string[] {
  return [
    join(homeDir, "Library", "Application Support", "FluidAudio"),
    join(homeDir, ".cache", "fluidaudio"),
    join(homeDir, "Library", "Application Support", "fluidaudio-rs"),
  ];
}

/**
 * Where each FluidAudio subsystem's files are. Mirrors `models.rs::fluidaudio_location` and
 * the per-subsystem probes it is called with — strong for ASR (`fluidaudio_asr_ready_in`),
 * `dir_has_entries` for Kokoro and Sortformer — so a legacy bundle that is still being read
 * is counted where it is, and a relocated one is counted only inside the cache (#688).
 */
export function fluidSubsystemDirs(options: FluidRootsOptions = {}): FluidSubsystem[] {
  const homeDir = options.homeDir ?? diagnosticHomeDir();
  const cacheRoot = options.cacheRoot ?? keshaCacheDir();
  const modelsRoot = join(cacheRoot, "fluidaudio");
  const asrLegacy = legacyFluidAsrCachePath(homeDir);
  const aneLegacy = legacyKokoroAneDir(homeDir);
  const sortformerLegacy = legacySortformerDir(homeDir);

  const at = (legacy: string, legacyReady: boolean, ...repoSubpath: string[]): string =>
    legacyReady ? legacy : join(modelsRoot, ...repoSubpath);

  return [
    {
      label: "ASR (Parakeet)",
      path: at(asrLegacy, fluidAsrCacheReady(asrLegacy), "parakeet-tdt-0.6b-v3"),
    },
    {
      label: "TTS (Kokoro ANE)",
      path: at(aneLegacy, dirHasEntries(aneLegacy), "kokoro-82m-coreml"),
    },
    { label: "TTS (Kokoro G2P)", path: kokoroG2pDir(homeDir) },
    {
      label: "Diarization (Sortformer)",
      path: at(
        sortformerLegacy,
        dirHasEntries(sortformerLegacy),
        "fluidaudio-rs",
        "SortformerCompiled",
      ),
    },
  ].map((subsystem) => ({ ...subsystem, inCache: isInsideDir(subsystem.path, cacheRoot) }));
}

/**
 * Every FluidAudio tree holding bytes outside the Kesha cache. A root with no subsystem
 * named is one the engine has stopped reading — still real disk usage, and the only way a
 * user finds it to delete it (#688).
 */
export function fluidExternalRoots(options: FluidRootsOptions = {}): FluidExternalRoot[] {
  const homeDir = options.homeDir ?? diagnosticHomeDir();
  const cacheRoot = options.cacheRoot ?? keshaCacheDir();
  const external = fluidSubsystemDirs({ homeDir, cacheRoot }).filter((s) => !s.inCache);

  const roots: FluidExternalRoot[] = [];
  for (const path of fluidLegacyRootPaths(homeDir)) {
    if (isInsideDir(path, cacheRoot)) continue;
    const sizeBytes = dirSizeBytes(path);
    if (sizeBytes === 0) continue;
    const subsystems = external
      .filter((s) => isInsideDir(s.path, path))
      .map((s) => ({ label: s.label, path: s.path, sizeBytes: dirSizeBytes(s.path) }));
    const accounted = subsystems.reduce((n, s) => n + s.sizeBytes, 0);
    roots.push({ path, sizeBytes, subsystems, otherBytes: Math.max(0, sizeBytes - accounted) });
  }
  return roots;
}

export function fluidExternalTotalBytes(roots: FluidExternalRoot[]): number {
  return roots.reduce((n, root) => n + root.sizeBytes, 0);
}
