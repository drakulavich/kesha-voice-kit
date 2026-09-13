import { describe, expect, test } from "bun:test";
import { LANG_CONFIDENCE_FLOOR, routeLanguage } from "../../src/language-routing";

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
