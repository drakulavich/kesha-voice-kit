import { describe, expect, test } from "bun:test";
import { resolveSayVoice } from "../../src/voice-routing";

// resolveSayVoice precedence: --voice > --lang (route by stated language,
// skip detection) > macOS auto-detect > engine default (undefined).
// The --voice and --lang branches return before touching the engine, so these
// are pure and platform-independent for `en`.
describe("resolveSayVoice precedence", () => {
  test("explicit --voice wins over a --lang hint", async () => {
    expect(await resolveSayVoice("ru-vosk-m02", "es", "Hola mundo")).toBe("ru-vosk-m02");
  });

  test("--lang routes to that language's default voice (skips detection)", async () => {
    expect(await resolveSayVoice(undefined, "en", "irrelevant")).toBe("en-am_michael");
    // BCP 47 region/script subtags are normalized away before lookup.
    expect(await resolveSayVoice(undefined, "en-US", "irrelevant")).toBe("en-am_michael");
    expect(await resolveSayVoice(undefined, "EN_us", "irrelevant")).toBe("en-am_michael");
  });

  test("--lang with no mapped voice → undefined (engine default), no re-detection", async () => {
    // German has no Kokoro voice on any platform → unmapped everywhere.
    expect(await resolveSayVoice(undefined, "de", "Hallo Welt")).toBeUndefined();
    // Unknown language code → unmapped.
    expect(await resolveSayVoice(undefined, "xx", "whatever")).toBeUndefined();
  });
});

// T2-10: native-script text routed to the Latin-only Kokoro packs can only ever be refused.
describe("resolveSayVoice native-script ja/hi routing", () => {
  const INSTALLED = [
    "en-am_michael",
    "hi-hm_omega",
    "ja-jm_kumo",
    "macos-com.apple.eloquence.ja-JP.Eddy",
    "macos-com.apple.voice.compact.ja-JP.Otoya",
    "macos-com.apple.voice.super-compact.hi-IN.Lekha",
    "macos-com.apple.voice.super-compact.ja-JP.Kyoko",
  ];
  const darwin = (listVoices: () => Promise<string[]>) =>
    ({ platform: "darwin", arch: "arm64", listVoices }) as const;
  const installed = darwin(async () => INSTALLED);

  test("Japanese in kana and kanji speaks through the male ja-JP AVSpeech voice", async () => {
    expect(await resolveSayVoice(undefined, "ja", "こんにちは世界", installed)).toBe(
      "macos-com.apple.voice.compact.ja-JP.Otoya",
    );
  });

  test("Devanagari Hindi speaks through the installed hi-IN AVSpeech voice", async () => {
    expect(await resolveSayVoice(undefined, "hi", "नमस्ते दुनिया", installed)).toBe(
      "macos-com.apple.voice.super-compact.hi-IN.Lekha",
    );
  });

  test("romanized Japanese still reaches the Kokoro voice that can read it", async () => {
    expect(await resolveSayVoice(undefined, "ja", "konnichiwa sekai", installed)).toBe(
      "ja-jm_kumo",
    );
  });

  test("an explicit --voice is never re-routed by the script of the text", async () => {
    expect(await resolveSayVoice("ja-jm_kumo", undefined, "こんにちは世界", installed)).toBe(
      "ja-jm_kumo",
    );
  });

  // No male ja-JP voice is installed on every Mac; the locale still speaks.
  test("falls back to the first installed voice for the locale when no male one is there", async () => {
    const withoutOtoya = darwin(async () => INSTALLED.filter((v) => !v.endsWith(".Otoya")));
    expect(await resolveSayVoice(undefined, "ja", "こんにちは世界", withoutOtoya)).toBe(
      "macos-com.apple.eloquence.ja-JP.Eddy",
    );
  });

  // Keeping the Kokoro voice is what leaves the engine free to refuse with its own hint.
  test("keeps the Kokoro voice when the locale has no AVSpeech voice installed", async () => {
    const noJapanese = darwin(async () => INSTALLED.filter((v) => !v.includes(".ja-JP.")));
    expect(await resolveSayVoice(undefined, "ja", "こんにちは世界", noJapanese)).toBe("ja-jm_kumo");
  });

  test("keeps the Kokoro voice when the voice list cannot be read", async () => {
    const noEngine = darwin(async () => {
      throw new Error("kesha-engine not installed");
    });
    expect(await resolveSayVoice(undefined, "hi", "नमस्ते दुनिया", noEngine)).toBe("hi-hm_omega");
  });

  test("a language with no native-script route never asks the engine for voices", async () => {
    const refuse = darwin(async () => {
      throw new Error("listVoiceIds must not be called for Spanish");
    });
    expect(await resolveSayVoice(undefined, "es", "Hola mundo", refuse)).toBe("es-em_alex");
  });
});
