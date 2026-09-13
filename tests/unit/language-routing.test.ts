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
