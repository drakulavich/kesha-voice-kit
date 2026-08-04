import { existsSync } from "fs";
import { join } from "path";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";
import { isDarwinArm64 } from "./fluid-kokoro-cache";

export const FLUID_ASR_CACHE_NOTE =
  "FluidAudio CoreML in-engine; the ASR weights are fetched by the backend during install warm-up, outside Kesha's pinned model cache";

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
    exists: supported && existsSync(path),
    sizeBytes: supported ? dirSizeBytes(path) : 0,
  };
}
