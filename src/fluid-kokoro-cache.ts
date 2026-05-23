import { existsSync } from "fs";
import { join } from "path";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";

export const FLUID_KOKORO_CACHE_NOTE =
  "FluidAudio CoreML in-engine; first warm-up may download/compile FluidAudio's Kokoro CoreML cache outside Kesha's pinned model cache";

const KOKORO_COREML_BUNDLES = ["kokoro_21_15s.mlmodelc", "kokoro_21_5s.mlmodelc"];

export interface FluidKokoroCacheInfo {
  supported: boolean;
  path: string;
  exists: boolean;
  sizeBytes: number;
}

export function isDarwinArm64(
  platform = process.platform,
  arch = process.arch,
): boolean {
  return platform === "darwin" && arch === "arm64";
}

export function fluidKokoroCachePath(homeDir = diagnosticHomeDir()): string {
  return join(homeDir, ".cache", "fluidaudio", "Models", "kokoro");
}

export function fluidKokoroCacheInfo(
  options: {
    platform?: typeof process.platform;
    arch?: typeof process.arch;
    homeDir?: string;
  } = {},
): FluidKokoroCacheInfo {
  const supported = isDarwinArm64(options.platform, options.arch);
  const path = fluidKokoroCachePath(options.homeDir);
  const exists =
    supported &&
    KOKORO_COREML_BUNDLES.some((bundle) => existsSync(join(path, bundle)));

  return {
    supported,
    path,
    exists,
    sizeBytes: supported ? dirSizeBytes(path) : 0,
  };
}
