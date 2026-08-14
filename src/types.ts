import type { LangDetectResult, TranscriptionSegment } from "./engine";

/**
 * Which detector produced a text-language result: the Engine's
 * `detect-text-lang` (macOS `NLLanguageRecognizer`) or the CLI-side `tinyld`
 * fallback used where the Engine call is unavailable (#941).
 */
export type TextLangSource = "engine" | "tinyld";

/**
 * A text-language detection tagged with its detector. The two sources score on
 * different scales — `NLLanguageRecognizer`'s probability vs `tinyld`'s n-gram
 * accuracy — so compare confidences within a source, never across them.
 */
export type TextLangDetectResult = LangDetectResult & { source: TextLangSource };

/** Canonical output shape for the public API (`@drakulavich/kesha-voice-kit/core`). */
export type TranscribeResult = {
  file: string;
  text: string;
  lang: string;
  audioLanguage?: LangDetectResult;
  textLanguage?: TextLangDetectResult;
  segments?: TranscriptionSegment[];
  /** Wall-clock time around the engine subprocess calls for this file, ms. See #139. */
  sttTimeMs?: number;
};

export type TranscribeErrorRecord = {
  file: string;
  /**
   * Taxonomy error code. The canonical set lives in Rust and is documented in
   * `docs/errors.md`; we type it as `string` so the precise engine code (e.g.
   * `E_DIARIZE_TIMEOUT`, `E_MODEL_MISSING`) flows through to `--include-errors`
   * output instead of being collapsed to a narrow union.
   */
  code: string;
  message: string;
};

export type TranscribeJsonOutput =
  | TranscribeResult[]
  | {
      results: TranscribeResult[];
      errors: TranscribeErrorRecord[];
    };

export function hasErrorRecords(
  output: TranscribeJsonOutput,
): output is { results: TranscribeResult[]; errors: TranscribeErrorRecord[] } {
  return !Array.isArray(output);
}

export type { LangDetectResult, TranscriptionSegment };
