import { existsSync } from "fs";
import { join } from "path";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";

export const FLUID_KOKORO_CACHE_NOTE =
  "FluidAudio CoreML in-engine; first synthesis compiles the ANE chain. `kesha install --tts` stages the shared G2P assets here, outside Kesha's pinned model cache, because FluidAudio resolves them from this path and no other";

// `G2PEncoder` is what a current install leaves here (#823); the two
// `kokoro_21_*` graphs are what a pre-0.15.5 install left, and are still worth
// reporting on a machine that never re-installed.
const KOKORO_COREML_BUNDLES = [
  "G2PEncoder.mlmodelc",
  "kokoro_21_15s.mlmodelc",
  "kokoro_21_5s.mlmodelc",
];

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
