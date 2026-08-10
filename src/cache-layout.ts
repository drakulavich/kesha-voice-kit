import { join, resolve, sep } from "path";

export interface CachePathEntry {
  label: string;
  path: string;
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
 * The Kesha-managed directories both `kesha status --disk` and `kesha doctor` report, in one
 * place so a new model dir cannot be added to only one of them. The two ASR rows are mutually
 * exclusive: a CoreML engine never populates the ONNX dir, and instead roots FluidAudio's own
 * subsystems under `<cache>/fluidaudio`, which is where the relocated bundles land (#688).
 * Whatever stayed in FluidAudio's own trees is outside this cache and is reported separately
 * by `fluidExternalRoots`.
 */
export function cacheComponentPaths(
  cacheRoot: string,
  engineDir: string,
  coreml: boolean,
): CachePathEntry[] {
  return [
    { label: "Engine", path: engineDir },
    ...(coreml
      ? [{ label: "FluidAudio (in cache)", path: join(cacheRoot, "fluidaudio") }]
      : [{ label: "ASR (Parakeet)", path: join(cacheRoot, "models/parakeet-tdt-v3") }]),
    { label: "Language ID", path: join(cacheRoot, "models/lang-id-ecapa") },
    { label: "VAD (Silero)", path: join(cacheRoot, "models/silero-vad") },
    { label: "TTS (Kokoro)", path: join(cacheRoot, "models/kokoro-82m") },
    { label: "TTS (Vosk)", path: join(cacheRoot, "models/vosk-ru") },
  ];
}
