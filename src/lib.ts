import { existsSync } from "fs";
import {
  isDirectoryPath,
  transcribe as internalTranscribe,
  transcribeWithSegments as internalTranscribeWithSegments,
  type TranscribeOptions,
} from "./transcribe";
import { downloadEngine } from "./engine-install";
import { KeshaError } from "./engine/events";

export type { TranscribeOptions };
export type { TranscriptionOutput, TranscriptionSegment, VadMode, WordTiming } from "./engine";
export { downloadEngine, downloadEngine as downloadModel };
export { say, type SayOptions, SayError } from "./synth";
export { KeshaError } from "./engine/events";

/**
 * Encode a `TranscribeResult[]` as TOON (#138). Same data shape as the
 * `--json` / `--toon` CLI output; the CLI reads from stdin of a transcribe
 * run, this helper is for programmatic callers that already have the array.
 */
export { formatToonOutput as toToon } from "./toon";

/**
 * Output shape returned by `kesha --json` and the input shape expected by
 * `toToon`. Lives in `./types` (since #179) so the public API stops
 * reaching into the CLI-layer file.
 */
export type {
  TranscribeErrorRecord,
  TranscribeJsonOutput,
  TranscribeResult,
} from "./types";
export { hasErrorRecords } from "./types";

/**
 * Install TTS models for the given languages (default: English only, matching
 * `kesha install --tts`). Pass e.g. `["en", "ru"]` for more.
 */
export async function downloadTts(noCache = false, langs: string[] = ["en"]): Promise<void> {
  await downloadEngine(noCache, undefined, { ttsLangs: langs });
}

/** @deprecated Use `downloadModel` instead. */
export const downloadCoreML = downloadEngine;

/** The same refusals the CLI makes before it spawns anything, so an agent branching on the documented code sees it on either surface. */
function assertAudioFileArgument(audioPath: string): void {
  if (!existsSync(audioPath)) {
    throw new KeshaError("E_INPUT_NOT_FOUND", `File not found: ${audioPath}`);
  }
  if (isDirectoryPath(audioPath)) {
    throw new KeshaError("E_INVALID_ARG", `${audioPath}: is a directory (expected an audio file)`);
  }
}

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<string> {
  assertAudioFileArgument(audioPath);
  return internalTranscribe(audioPath, options);
}

export async function transcribeWithTimestamps(
  audioPath: string,
  options: TranscribeOptions = {},
) {
  assertAudioFileArgument(audioPath);

  return internalTranscribeWithSegments(audioPath, {
    ...options,
    timestamps: true,
  });
}

/**
 * @deprecated Renamed to {@link transcribeWithTimestamps} (#248). The old
 * name shipped briefly in v1.9.0; this alias keeps existing imports working.
 * No removal is scheduled before the next major version.
 */
export const transcribeWithSegments = transcribeWithTimestamps;
