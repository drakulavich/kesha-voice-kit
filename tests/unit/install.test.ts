import { describe, expect, test } from "bun:test";
import { resolveTtsLangs } from "../../src/cli/install";

const caps = ["en", "es", "fr", "it", "pt", "ru"];

describe("resolveTtsLangs", () => {
  test("bare --tts defaults to en", () => {
    expect(resolveTtsLangs({ tts: true, positionals: [] }, caps)).toEqual(["en"]);
  });
  test("explicit languages pass through", () => {
    expect(resolveTtsLangs({ tts: true, positionals: ["en", "ru"] }, caps)).toEqual(["en", "ru"]);
  });
  test("no --tts with positionals -> error", () => {
    expect(() => resolveTtsLangs({ tts: false, positionals: ["en"] }, caps)).toThrow(/require .*--tts/i);
  });
  test("unsupported language is a hard error naming the code", () => {
    expect(() => resolveTtsLangs({ tts: true, positionals: ["ja"] }, caps)).toThrow(/ja/);
  });
  test("tts disabled and no positionals -> empty", () => {
    expect(resolveTtsLangs({ tts: false, positionals: [] }, caps)).toEqual([]);
  });
  test("undefined supported set skips the unsupported check (engine validates)", () => {
    expect(resolveTtsLangs({ tts: true, positionals: ["ja"] }, undefined)).toEqual(["ja"]);
  });
});
