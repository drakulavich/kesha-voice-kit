import { join } from "path";

export interface CachePathEntry {
  label: string;
  path: string;
}

/**
 * The Kesha-managed directories both `kesha status --disk` and `kesha doctor` report, in one
 * place so a new model dir cannot be added to only one of them. A CoreML engine never
 * populates the ONNX ASR dir and keeps its own bundle outside this cache, so that row is
 * dropped rather than rendered as missing; callers list it under external caches (#684).
 */
export function cacheComponentPaths(
  cacheRoot: string,
  engineDir: string,
  coreml: boolean,
): CachePathEntry[] {
  return [
    { label: "Engine", path: engineDir },
    ...(coreml
      ? []
      : [{ label: "ASR (Parakeet)", path: join(cacheRoot, "models/parakeet-tdt-v3") }]),
    { label: "Language ID", path: join(cacheRoot, "models/lang-id-ecapa") },
    { label: "VAD (Silero)", path: join(cacheRoot, "models/silero-vad") },
    { label: "TTS (Kokoro)", path: join(cacheRoot, "models/kokoro-82m") },
    { label: "TTS (Vosk)", path: join(cacheRoot, "models/vosk-ru") },
  ];
}
