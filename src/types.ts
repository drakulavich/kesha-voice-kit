import type { LangDetectResult, TranscriptionSegment } from "./engine";

/**
 * One row of `kesha --json` / `kesha --toon` output. Canonical output shape
 * for programmatic callers of `transcribe(...)` + `toToon(...)` in the
 * public API (`@drakulavich/kesha-voice-kit/core`).
 */
export type TranscribeResult = {
  file: string;
  text: string;
  lang: string;
  audioLanguage?: LangDetectResult;
  textLanguage?: LangDetectResult;
  /** Timestamped transcript segments when requested via `--timestamps`. */
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

export type { LangDetectResult, TranscriptionSegment };
