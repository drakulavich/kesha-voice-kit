import { existsSync } from "fs";
import { join } from "path";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";
import { isDarwinArm64 } from "./fluid-kokoro-cache";

export const FLUID_ASR_CACHE_NOTE =
  "FluidAudio CoreML in-engine; the ASR weights are fetched by the backend during install warm-up, outside Kesha's pinned model cache";

/**
 * Which ASR layout applies. The engine's reported backend is authoritative, but the
 * capabilities probe can fail on a perfectly healthy install — falling through to
 * "not CoreML" there would point darwin diagnostics at an ONNX directory this platform
 * never populates and render a working install as broken (#684).
 */
export function isCoremlBackend(backend?: string): boolean {
  if (backend) return backend === "coreml";
  return isDarwinArm64();
}

export interface FluidAsrCacheInfo {
  supported: boolean;
  path: string;
  exists: boolean;
  sizeBytes: number;
}

/**
 * FluidAudio loads ASR from `<ApplicationSupport>/FluidAudio/Models/<repo folder>`,
 * and that folder name has the `-coreml` suffix stripped — the `…-v3-coreml` sibling
 * that also appears on disk is not what it reads (#684).
 */
export function fluidAsrCachePath(homeDir = diagnosticHomeDir()): string {
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
 * What FluidAudio's own `modelsExist` requires. The encoder is pinned to int8 because
 * the bridge calls `downloadAndLoad(to:)` with its default `useInt8Encoder: true` —
 * accepting `EncoderInt4.mlmodelc` would pass preflight and then let FluidAudio fetch
 * the int8 encoder on first transcribe. Keep in step with `models.rs::FLUID_ASR_REQUIRED`.
 */
const FLUID_ASR_REQUIRED = [
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
 */
export function fluidAsrCacheReady(path: string): boolean {
  return FLUID_ASR_REQUIRED.every((f) => existsSync(join(path, f)));
}

export function fluidAsrCacheInfo(
  options: {
    platform?: typeof process.platform;
    arch?: typeof process.arch;
    homeDir?: string;
  } = {},
): FluidAsrCacheInfo {
  const supported = isDarwinArm64(options.platform, options.arch);
  const path = fluidAsrCachePath(options.homeDir);

  return {
    supported,
    path,
    exists: supported && fluidAsrCacheReady(path),
    sizeBytes: supported ? dirSizeBytes(path) : 0,
  };
}
