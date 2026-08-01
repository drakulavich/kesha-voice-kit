import { describe, expect, test } from "bun:test";
import { defaultBackendForPlatform, resolveTtsLangs } from "../../src/cli/install";

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

describe("defaultBackendForPlatform", () => {
  // A defined backend is what lets performInstall reject `--coreml` before the download.
  test("win32-x64 auto-detects onnx", () => {
    expect(defaultBackendForPlatform("win32", "x64")).toBe("onnx");
  });
  test("darwin-arm64 auto-detects coreml", () => {
    expect(defaultBackendForPlatform("darwin", "arm64")).toBe("coreml");
  });
  test("linux-x64 auto-detects onnx", () => {
    expect(defaultBackendForPlatform("linux", "x64")).toBe("onnx");
  });
  test("unshipped platforms stay undefined", () => {
    expect(defaultBackendForPlatform("darwin", "x64")).toBeUndefined();
    expect(defaultBackendForPlatform("linux", "arm64")).toBeUndefined();
    expect(defaultBackendForPlatform("freebsd", "x64")).toBeUndefined();
  });
});
