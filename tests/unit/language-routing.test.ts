import { describe, expect, test } from "bun:test";
import {
  LANG_CONFIDENCE_FLOOR,
  routeLanguage,
  UNSUPPORTED_AUDIO_LANGUAGE_CONFIDENCE,
  unsupportedAudioLanguageWarning,
} from "../../src/language-routing";

describe("routeLanguage (Exploratory S11-2)", () => {
  test("an Engine text result names lang whatever its score: its scale is not tinyld's", () => {
    const route = routeLanguage({ textLanguage: { code: "ru", confidence: 0.3, source: "engine" } });
    expect(route.lang).toBe("ru");
    expect(route.belowFloor.text).toBe(false);
  });

  test("a tinyld guess at or above the floor names lang", () => {
    const route = routeLanguage({
      textLanguage: { code: "en", confidence: LANG_CONFIDENCE_FLOOR, source: "tinyld" },
    });
    expect(route.lang).toBe("en");
    expect(route.belowFloor.text).toBe(false);
  });

  test("a tinyld guess below the floor leaves lang empty and is reported as ignored", () => {
    const route = routeLanguage({
      textLanguage: { code: "ber", confidence: 0.333, source: "tinyld" },
    });
    expect(route.lang).toBe("");
    expect(route.belowFloor.text).toBe(true);
  });

  test("no detection at all routes to an empty lang with nothing ignored", () => {
    expect(routeLanguage({})).toEqual({ lang: "", source: null, belowFloor: { audio: false, text: false } });
  });
});

describe("routeLanguage audio floor (Exploratory S11-4)", () => {
  test("audio at or above the floor names lang when no text guess cleared it", () => {
    const route = routeLanguage({
      audioLanguage: { code: "en", confidence: 0.99 },
      textLanguage: { code: "ber", confidence: 0.333, source: "tinyld" },
    });
    expect(route.lang).toBe("en");
    expect(route.source).toBe("audio");
    expect(route.belowFloor).toEqual({ audio: false, text: true });
  });

  test("a text result that cleared the floor still wins over confident audio", () => {
    const route = routeLanguage({
      audioLanguage: { code: "en", confidence: 0.99 },
      textLanguage: { code: "ru", confidence: 0.9, source: "engine" },
    });
    expect(route.lang).toBe("ru");
    expect(route.source).toBe("engine");
  });

  test("silence's no-signal prior does not become a language", () => {
    const route = routeLanguage({ audioLanguage: { code: "nn", confidence: 0.267 } });
    expect(route.lang).toBe("");
    expect(route.belowFloor.audio).toBe(true);
  });
});

describe("audio language outside the ASR set (#1463)", () => {
  const zhAudio = { code: "zh", confidence: 0.999984 };
  const viFromGibberish = { code: "vi", confidence: 0.6291093826293945, source: "engine" as const };

  test("confident zh audio names lang instead of a text guess on the romanized transcript", () => {
    const route = routeLanguage({ audioLanguage: zhAudio, textLanguage: viFromGibberish });
    expect(route.lang).toBe("zh");
    expect(route.source).toBe("audio");
  });

  test("confident zh audio gets a warning naming the language", () => {
    expect(unsupportedAudioLanguageWarning(zhAudio, viFromGibberish)).toBe(
      'warning: audio language "zh" is not one kesha can transcribe; the text is unreliable (supported: docs/languages.md)',
    );
  });

  test("an ASR language in the audio gets no warning and text still names lang", () => {
    const audio = { code: "en", confidence: 0.99 };
    expect(unsupportedAudioLanguageWarning(audio, undefined)).toBeNull();
    expect(routeLanguage({ audioLanguage: audio, textLanguage: { code: "ru", confidence: 0.9, source: "engine" } }).lang).toBe(
      "ru",
    );
  });

  test("an unsure zh audio guess neither warns nor overrides the text", () => {
    const audio = { code: "zh", confidence: UNSUPPORTED_AUDIO_LANGUAGE_CONFIDENCE - 0.01 };
    expect(unsupportedAudioLanguageWarning(audio, undefined)).toBeNull();
    expect(routeLanguage({ audioLanguage: audio, textLanguage: viFromGibberish }).lang).toBe("vi");
  });
});

describe("confident non-ASR audio against a text result in the ASR set (#1463 false positive)", () => {
  const beAudio = { code: "be", confidence: 0.9546 };
  const enText = { code: "en", confidence: 0.974, source: "engine" as const };

  test("English text at or above the floor keeps lang and gets no warning when audio says be", () => {
    expect(routeLanguage({ audioLanguage: beAudio, textLanguage: enText }).lang).toBe("en");
    expect(unsupportedAudioLanguageWarning(beAudio, enText)).toBeNull();
  });

  test("ja audio still overrides an ASR-set text guess below the floor", () => {
    const jaAudio = { code: "ja", confidence: 0.999 };
    const plText = { code: "pl", confidence: 0.485, source: "engine" as const };
    expect(routeLanguage({ audioLanguage: jaAudio, textLanguage: plText }).lang).toBe("ja");
    expect(unsupportedAudioLanguageWarning(jaAudio, plText)).toContain('"ja"');
  });
});
