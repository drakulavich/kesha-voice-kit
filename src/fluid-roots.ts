import { createHash } from "crypto";
import { lstatSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { isInsideDir } from "./cache-layout";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";
import { humanBytes } from "./format";
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
 * Mirrors `models/paths.rs::dir_has_entries`. Deliberately weak: a false positive keeps a legacy
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
export function kokoroG2pDir(homeDir = diagnosticHomeDir()): string {
  return join(homeDir, ".cache", "fluidaudio", "Models", "kokoro");
}

/**
 * The Kokoro CoreML bundle root the engine reads. Mirrors
 * `models/paths.rs::fluidaudio_kokoro_location`: any entry at all keeps a legacy tree in use,
 * everything else roots under the Kesha cache (#688).
 */
export function kokoroBundleRoot(options: FluidRootsOptions = {}): string {
  const legacy = legacyKokoroAneDir(options.homeDir ?? diagnosticHomeDir());
  return dirHasEntries(legacy)
    ? legacy
    : join(options.cacheRoot ?? keshaCacheDir(), "fluidaudio", "kokoro-82m-coreml");
}

/** Where `models/staging.rs::stage_fluidaudio_kokoro_assets` puts the English ANE chain. */
export function kokoroAneDir(options: FluidRootsOptions = {}): string {
  return join(kokoroBundleRoot(options), "ANE");
}

/** The Mandarin sibling bundle; mirrors `models/paths.rs::fluidaudio_ane_zh_kokoro_dir`. */
export function kokoroAneZhDir(options: FluidRootsOptions = {}): string {
  return join(kokoroBundleRoot(options), "ANE-zh");
}

/**
 * FluidAudio's own VAD copy, distinct from the Silero model Kesha pins under `<cache>/models`.
 * The bridge passes no directory for VAD, so this stays put whatever the models root is —
 * and it is in use, which is why it is named rather than left in a root's residue (#688).
 */
function fluidVadDir(homeDir: string): string {
  return join(homeDir, "Library", "Application Support", "FluidAudio", "Models", "silero-vad");
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
 * Where each FluidAudio subsystem's files are. Mirrors `models/paths.rs::fluidaudio_location` and
 * the per-subsystem probes it is called with — strong for ASR (`fluidaudio_asr_ready_in`),
 * `dir_has_entries` for Kokoro and Sortformer — so a legacy bundle that is still being read
 * is counted where it is, and a relocated one is counted only inside the cache (#688).
 */
export function fluidSubsystemDirs(options: FluidRootsOptions = {}): FluidSubsystem[] {
  const homeDir = options.homeDir ?? diagnosticHomeDir();
  const cacheRoot = options.cacheRoot ?? keshaCacheDir();
  const modelsRoot = join(cacheRoot, "fluidaudio");
  const asrLegacy = legacyFluidAsrCachePath(homeDir);
  const sortformerLegacy = legacySortformerDir(homeDir);

  const at = (legacy: string, legacyReady: boolean, ...repoSubpath: string[]): string =>
    legacyReady ? legacy : join(modelsRoot, ...repoSubpath);

  return [
    {
      label: "ASR (Parakeet)",
      path: at(asrLegacy, fluidAsrCacheReady(asrLegacy), "parakeet-tdt-0.6b-v3"),
    },
    { label: "VAD (Silero, FluidAudio)", path: fluidVadDir(homeDir) },
    { label: "TTS (Kokoro ANE)", path: kokoroBundleRoot({ homeDir, cacheRoot }) },
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
 * Every FluidAudio tree holding bytes outside the Kesha cache, with the subsystems still
 * resolved into it. Bytes no subsystem claims stay in `otherBytes` rather than being dropped:
 * they are real disk usage, and naming the root is the only way a user finds them (#688).
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
      .map((s) => ({ label: s.label, path: s.path, sizeBytes: dirSizeBytes(s.path) }))
      .filter((s) => s.sizeBytes > 0);
    const accounted = subsystems.reduce((n, s) => n + s.sizeBytes, 0);
    roots.push({ path, sizeBytes, subsystems, otherBytes: Math.max(0, sizeBytes - accounted) });
  }
  return roots;
}

export function fluidExternalTotalBytes(roots: FluidExternalRoot[]): number {
  return roots.reduce((n, root) => n + root.sizeBytes, 0);
}

/**
 * The bundle name fluidaudio-rs compiles `modelPackage` to: SHA-256 of
 * `<path>|<bytes in files>|<newest mtime of files and dirs, whole seconds>`.
 * Mirrors `cacheKey(forModelPath:)` in its FluidAudioBridge.swift and `sortformer_compiled_name` in
 * `rust/src/models/download.rs`; a drift reports the bundle in use as stale.
 */
export function sortformerCompiledName(modelPackage: string): string {
  let size = 0n;
  let newest = 0n;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const st = lstatSync(join(dir, name), { bigint: true });
      if (st.isFile()) size += st.size;
      if (st.isFile() || st.isDirectory()) {
        const mtime = st.mtimeNs / 1_000_000_000n;
        if (mtime > newest) newest = mtime;
      }
      if (st.isDirectory()) walk(join(dir, name));
    }
  };
  try {
    walk(modelPackage);
  } catch {
    // A missing package compiles to nothing, so every bundle on disk is stale.
  }
  const material = `${resolve(modelPackage)}|${size}|${newest}`;
  return `${createHash("sha256").update(material).digest("hex")}.mlmodelc`;
}

export function staleSortformerHint(bytes: number): string {
  return `  Stale Sortformer compilations: ${humanBytes(bytes)}; run \`kesha install --diarize\` to remove them`;
}

/** Bytes in compiled Sortformer bundles other than the installed package's (#1473 S5-6). */
export function staleSortformerBytes(options: FluidRootsOptions = {}): number {
  const cacheRoot = options.cacheRoot ?? keshaCacheDir();
  const dir = fluidSubsystemDirs({ ...options, cacheRoot }).find(
    (s) => s.label === "Diarization (Sortformer)",
  )!.path;
  const current = sortformerCompiledName(
    join(cacheRoot, "models", "diarize", "SortformerNvidiaLow_v2.mlpackage"),
  );
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  return names
    .filter((name) => name.endsWith(".mlmodelc") && name !== current)
    .reduce((n, name) => n + dirSizeBytes(join(dir, name)), 0);
}
