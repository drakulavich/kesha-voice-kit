import type { LangDetectResult } from "./engine";
import type { TextLangDetectResult } from "./types";

/** A guess scoring below this is kept in its raw field but never names the top-level `lang` (Exploratory S11-2). */
export const LANG_CONFIDENCE_FLOOR = 0.5;

export type LangRouteSource = "engine" | "tinyld" | "audio";

export interface LanguageRoute {
  lang: string;
  source: LangRouteSource | null;
  belowFloor: { audio: boolean; text: boolean };
}

/**
 * Picks the top-level `lang` from what the detectors returned. The Engine's text result
 * is trusted as-is; a `tinyld` guess must clear `LANG_CONFIDENCE_FLOOR`.
 */
export function routeLanguage(input: {
  audioLanguage?: LangDetectResult;
  textLanguage?: TextLangDetectResult;
}): LanguageRoute {
  const { textLanguage } = input;
  const textBelowFloor =
    textLanguage !== undefined &&
    textLanguage.source === "tinyld" &&
    textLanguage.confidence < LANG_CONFIDENCE_FLOOR;
  const belowFloor = { audio: false, text: textBelowFloor };
  if (textLanguage?.code && !textBelowFloor) {
    return { lang: textLanguage.code, source: textLanguage.source, belowFloor };
  }
  return { lang: "", source: null, belowFloor };
}
