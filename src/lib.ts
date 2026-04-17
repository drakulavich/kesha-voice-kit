import { existsSync } from "fs";
import { transcribe as internalTranscribe, type TranscribeOptions } from "./transcribe";
import { downloadEngine } from "./engine-install";

export type { TranscribeOptions };
export { downloadEngine as downloadModel };
export { say, type SayOptions, SayError } from "./say";

/** Install Kokoro TTS models. Shorthand for `downloadModel({ tts: true })`. */
export async function downloadTts(noCache = false): Promise<void> {
  await downloadEngine(noCache, undefined, { tts: true });
}

/** @deprecated Use `downloadModel` instead. */
export const downloadCoreML = downloadEngine;

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<string> {
  if (!existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  return internalTranscribe(audioPath, { ...options, silent: true });
}
