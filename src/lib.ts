import { existsSync } from "fs";
import { transcribe as internalTranscribe, type TranscribeOptions } from "./transcribe";
import { downloadEngine } from "./engine-install";

export type { TranscribeOptions };
export { downloadEngine as downloadModel };
export { say, type SayOptions, SayError } from "./say";

/**
 * Encode a `TranscribeResult[]` as TOON (#138). Same data shape as the
 * `--json` / `--toon` CLI output; the CLI reads from stdin of a transcribe
 * run, this helper is for programmatic callers that already have the array.
 */
export { formatToonOutput as toToon } from "./toon";

/**
 * Output shape returned by `kesha --json` and the input shape expected by
 * `toToon`. Re-exported here so programmatic callers can type-check
 * their array without reaching into `./cli`. `export type` is erased at
 * runtime, so no cycle even though the value still lives in `cli.ts`.
 */
export type { TranscribeResult } from "./cli";

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
