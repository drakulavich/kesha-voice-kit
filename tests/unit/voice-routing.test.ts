import { describe, it, expect } from "bun:test";
import { pickVoiceForLang } from "../../src/voice-routing";

/** Mirrors `rust/src/models.rs::tts_languages()` — keep in sync when adding a language. */
const ADVERTISED_TTS_LANGS = {
  systemKokoro: ["en", "es", "fr", "hi", "it", "ja", "pt", "zh", "ru"],
  onnx: ["en", "es", "fr", "it", "pt", "ru"],
};

describe("pickVoiceForLang (auto-routing)", () => {
  it("returns en-am_michael for English with high confidence", () => {
    expect(pickVoiceForLang("en", 0.95)).toBe("en-am_michael");
  });

  it("returns Milena for Russian on darwin (zero-install AVSpeech path)", () => {
    expect(pickVoiceForLang("ru", 0.95, "darwin")).toBe(
      "macos-com.apple.voice.compact.ru-RU.Milena",
    );
  });

  it("falls back to ru-vosk-m02 for Russian on non-darwin (Vosk replaces Piper-ruslan, #213)", () => {
    expect(pickVoiceForLang("ru", 0.95, "linux")).toBe("ru-vosk-m02");
    expect(pickVoiceForLang("ru", 0.95, "win32")).toBe("ru-vosk-m02");
  });

  it("routes supported Kokoro languages to male FluidAudio voices on darwin-arm64", () => {
    expect(pickVoiceForLang("es", 0.95, "darwin", "arm64")).toBe("es-em_alex");
    expect(pickVoiceForLang("es-ES", 0.95, "darwin", "arm64")).toBe("es-em_alex");
    expect(pickVoiceForLang("hi", 0.95, "darwin", "arm64")).toBe("hi-hm_omega");
    // fr is female — the documented brand-rule exception, Kokoro v1.0 has no male fr voice.
    expect(pickVoiceForLang("fr", 0.95, "darwin", "arm64")).toBe("fr-ff_siwis");
    expect(pickVoiceForLang("fr-CA", 0.95, "darwin", "arm64")).toBe("fr-ff_siwis");
    expect(pickVoiceForLang("it", 0.95, "darwin", "arm64")).toBe("it-im_nicola");
    expect(pickVoiceForLang("ja", 0.95, "darwin", "arm64")).toBe("ja-jm_kumo");
    expect(pickVoiceForLang("pt-BR", 0.95, "darwin", "arm64")).toBe("pt-pm_alex");
    expect(pickVoiceForLang("zh-Hans", 0.95, "darwin", "arm64")).toBe("zh-zm_050");
  });

  it("does not auto-route languages without an ONNX voice pack on non-darwin", () => {
    // hi/ja/zh have no ONNX voice pack; they should not be auto-routed.
    expect(pickVoiceForLang("ja", 0.95, "linux")).toBeUndefined();
    expect(pickVoiceForLang("hi", 0.95, "win32")).toBeUndefined();
    expect(pickVoiceForLang("zh", 0.95, "linux")).toBeUndefined();
  });

  it("routes es/fr/it/pt to multilingual ONNX voices on non-darwin-arm64 (Track B)", () => {
    // Linux and Windows use ONNX Kokoro with CharsiuG2P for these four languages.
    for (const platform of ["linux", "win32"] as const) {
      expect(pickVoiceForLang("es", 0.95, platform)).toBe("es-em_alex");
      expect(pickVoiceForLang("fr", 0.95, platform)).toBe("fr-ff_siwis");
      expect(pickVoiceForLang("it", 0.95, platform)).toBe("it-im_nicola");
      expect(pickVoiceForLang("pt", 0.95, platform)).toBe("pt-pm_alex");
    }
    // Intel macOS also uses ONNX path (no FluidAudio arm64 voice pack).
    expect(pickVoiceForLang("es", 0.95, "darwin", "x64")).toBe("es-em_alex");
    expect(pickVoiceForLang("fr", 0.95, "darwin", "x64")).toBe("fr-ff_siwis");
    expect(pickVoiceForLang("it", 0.95, "darwin", "x64")).toBe("it-im_nicola");
    expect(pickVoiceForLang("pt", 0.95, "darwin", "x64")).toBe("pt-pm_alex");
  });

  it("routes ONNX-supported langs on Intel macOS; ja/hi/zh without ONNX pack return undefined", () => {
    // ja/hi/zh have no ONNX voice pack — still undefined on Intel macOS.
    expect(pickVoiceForLang("ja", 0.95, "darwin", "x64")).toBeUndefined();
    expect(pickVoiceForLang("hi", 0.95, "darwin", "x64")).toBeUndefined();
    // en (ONNX Kokoro) and ru (AVSpeech Milena) still route on Intel Macs.
    expect(pickVoiceForLang("en", 0.95, "darwin", "x64")).toBe("en-am_michael");
    expect(pickVoiceForLang("ru", 0.95, "darwin", "x64")).toBe(
      "macos-com.apple.voice.compact.ru-RU.Milena",
    );
  });

  it("returns undefined below 0.5 confidence (too ambiguous)", () => {
    expect(pickVoiceForLang("ru", 0.3)).toBeUndefined();
  });

  it("returns undefined for unsupported languages", () => {
    // de/ko have no Kokoro voice on either the ONNX or the darwin path.
    expect(pickVoiceForLang("de", 0.95, "linux", "x64")).toBeUndefined();
    expect(pickVoiceForLang("ko", 0.95, "darwin", "arm64")).toBeUndefined();
  });

  it("routes every language the darwin-arm64 build advertises in --capabilities-json", () => {
    const unrouted = ADVERTISED_TTS_LANGS.systemKokoro.filter(
      (lang) => pickVoiceForLang(lang, 0.95, "darwin", "arm64") === undefined,
    );
    expect(unrouted).toEqual([]);
  });

  it("routes every language ONNX builds advertise in --capabilities-json", () => {
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["win32", "x64"],
      ["darwin", "x64"],
    ] as const) {
      const unrouted = ADVERTISED_TTS_LANGS.onnx.filter(
        (lang) => pickVoiceForLang(lang, 0.95, platform, arch) === undefined,
      );
      expect(unrouted).toEqual([]);
    }
  });

  it("returns undefined when code is missing", () => {
    expect(pickVoiceForLang(undefined, 0.95)).toBeUndefined();
    expect(pickVoiceForLang("", 0.95)).toBeUndefined();
  });
});
