import type { LangDetectResult } from "./engine";
import type { TextLangDetectResult } from "./types";

/** A guess scoring below this is kept in its raw field but never names the top-level `lang` (Exploratory S11-2, S11-4). */
export const LANG_CONFIDENCE_FLOOR = 0.5;

export type LangRouteSource = "engine" | "tinyld" | "audio";

export interface LanguageRoute {
  lang: string;
  source: LangRouteSource | null;
  belowFloor: { audio: boolean; text: boolean };
}

/**
 * Picks the top-level `lang` from what the detectors returned: the Engine's text result as-is,
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
  if (textLanguage?.code && !textBelowFloor) {
    return { lang: textLanguage.code, source: textLanguage.source, belowFloor };
  }
  if (audioLanguage?.code && !audioBelowFloor) {
    return { lang: audioLanguage.code, source: "audio", belowFloor };
  }
  return { lang: "", source: null, belowFloor };
}
