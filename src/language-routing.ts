import { detectAll } from "tinyld";
import type { LangDetectResult } from "./engine";
import type { TextLangDetectResult } from "./types";

/** A guess scoring below this is kept in its raw field but never names the top-level `lang` (Exploratory S11-2, S11-4). */
export const LANG_CONFIDENCE_FLOOR = 0.5;

/** The speech-to-text languages in docs/languages.md; keep the two in step. */
const ASR_LANGUAGES = new Set([
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk",
]);

/** Audio lang-id this sure of a non-ASR language outranks text detection on the transcript (#1463: zh audio 0.999 vs text 0.63). */
export const UNSUPPORTED_AUDIO_LANGUAGE_CONFIDENCE = 0.95;

export function unsupportedAudioLanguageWarning(audioLanguage: LangDetectResult | undefined): string | null {
  if (!audioLanguage?.code || audioLanguage.confidence < UNSUPPORTED_AUDIO_LANGUAGE_CONFIDENCE) return null;
  if (ASR_LANGUAGES.has(audioLanguage.code)) return null;
  return `warning: audio language "${audioLanguage.code}" is not one kesha can transcribe; the text is unreliable (supported: docs/languages.md)`;
}

export type LangRouteSource = "engine" | "tinyld" | "audio";

export interface LanguageRoute {
  lang: string;
  source: LangRouteSource | null;
  belowFloor: { audio: boolean; text: boolean };
}

/**
 * Picks the top-level `lang` from what the detectors returned: confident audio in a language outside the ASR set,
 * else the Engine's text result as-is,
 * else a `tinyld` guess that clears `LANG_CONFIDENCE_FLOOR`, else audio that clears it, else "".
 */
export function routeLanguage(input: {
  audioLanguage?: LangDetectResult;
  textLanguage?: TextLangDetectResult;
}): LanguageRoute {
  const { audioLanguage, textLanguage } = input;
  const textBelowFloor =
    textLanguage !== undefined &&
    textLanguage.source === "tinyld" &&
    textLanguage.confidence < LANG_CONFIDENCE_FLOOR;
  const audioBelowFloor = audioLanguage !== undefined && audioLanguage.confidence < LANG_CONFIDENCE_FLOOR;
  const belowFloor = { audio: audioBelowFloor, text: textBelowFloor };
  if (audioLanguage && unsupportedAudioLanguageWarning(audioLanguage)) {
    return { lang: audioLanguage.code, source: "audio", belowFloor };
  }
  if (textLanguage?.code && !textBelowFloor) {
    return { lang: textLanguage.code, source: textLanguage.source, belowFloor };
  }
  if (audioLanguage?.code && !audioBelowFloor) {
    return { lang: audioLanguage.code, source: "audio", belowFloor };
  }
  return { lang: "", source: null, belowFloor };
}

/**
 * The CLI-side `tinyld` fallback, tagged `source: "tinyld"` so a consumer can
 * tell it apart from an Engine detection instead of reading the placeholder
 * `confidence: 0` it used to carry as a genuine zero (#941). The score is
 * tinyld's own and is not on the Engine's scale.
 */
export function detectTextLanguageFallback(text: string): TextLangDetectResult | undefined {
  if (!text) return undefined;
  const [best] = detectAll(text);
  if (!best) return undefined;
  return { code: best.lang, confidence: best.accuracy, source: "tinyld" };
}
