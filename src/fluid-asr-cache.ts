import { existsSync } from "fs";
import { join } from "path";
import { diagnosticHomeDir } from "./diagnostic-paths";
import { engineTarget } from "./engine-targets";
import { keshaCacheDir } from "./paths";

// Says nothing about location: since #688 the bundle may sit inside the Kesha cache or in
// FluidAudio's own tree, and either way it is the backend that fetches it, not the pinned
// downloader — which is what the note is actually warning about.
export const FLUID_ASR_CACHE_NOTE =
  "required for speech-to-text; fetched by the backend during warm-up, not by Kesha's pinned downloader";

/**
 * Which ASR layout applies. The reported backend is authoritative; when the capabilities
 * probe yields nothing, fall back to the platform's shipped backend rather than to "not
 * CoreML", which would point darwin at an ONNX directory it never populates (#684).
 */
export function isCoremlBackend(
  backend?: string,
  platform?: string,
  arch?: string,
): boolean {
  return (backend ?? engineTarget(platform, arch)?.backend) === "coreml";
}

/**
 * FluidAudio loads ASR from `<ApplicationSupport>/FluidAudio/Models/<repo folder>`,
 * and that folder name has the `-coreml` suffix stripped — the `…-v3-coreml` sibling
 * that also appears on disk is not what it reads (#684). This is the location FluidAudio
 * picks unaided, which #688 keeps as a read-fallback.
 */
export function legacyFluidAsrCachePath(homeDir = diagnosticHomeDir()): string {
  return join(
    homeDir,
    "Library",
    "Application Support",
    "FluidAudio",
    "Models",
    "parakeet-tdt-0.6b-v3",
  );
}

/**
 * Where the Parakeet bundle actually is. Mirrors `models.rs::fluidaudio_asr_location`: a
 * complete legacy bundle keeps its place so an upgrade never re-downloads ~460 MB, and
 * anything else lives under the Kesha cache, where the engine roots a fresh install (#688).
 */
export function fluidAsrCachePath(
  homeDir = diagnosticHomeDir(),
  cacheRoot = keshaCacheDir(),
): string {
  const legacy = legacyFluidAsrCachePath(homeDir);
  return fluidAsrCacheReady(legacy)
    ? legacy
    : join(cacheRoot, "fluidaudio", "parakeet-tdt-0.6b-v3");
}

/**
 * What FluidAudio's own `modelsExist` requires. The encoder is pinned to int8 because
 * the bridge calls `downloadAndLoad(to:)` with its default `useInt8Encoder: true` —
 * accepting `EncoderInt4.mlmodelc` would pass preflight and then let FluidAudio fetch
 * the int8 encoder on first transcribe. Keep in step with `models.rs::FLUID_ASR_REQUIRED`.
 */
export const FLUID_ASR_REQUIRED = [
  "Preprocessor.mlmodelc",
  "Encoder.mlmodelc",
  "Decoder.mlmodelc",
  "JointDecisionv3.mlmodelc",
  "parakeet_vocab.json",
];

/**
 * Complete enough to transcribe. Mirrors `models.rs::fluidaudio_asr_ready` — a bare
 * directory check would call an interrupted fetch healthy, and the engine would then
 * download the remainder on first transcribe (#684).
 *
 * Existence-only on purpose: FluidAudio's own `modelsExist` is `fileExists` over the same
 * names, and its download skips whatever that predicate accepts. Requiring more here (that
 * each `.mlmodelc` is a directory, that `coremldata.bin` is inside) would report not-ready
 * for a bundle FluidAudio considers present, so `kesha install` would fetch nothing and the
 * user could never clear the error. Match the loader; do not out-strict it.
 */
export function fluidAsrCacheReady(path: string): boolean {
  return FLUID_ASR_REQUIRED.every((f) => existsSync(join(path, f)));
}
