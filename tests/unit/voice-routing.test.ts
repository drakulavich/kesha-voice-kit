import { describe, it, expect } from "bun:test";
import { pickVoiceForLang } from "../../src/voice-routing";

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
    expect(pickVoiceForLang("it", 0.95, "darwin", "arm64")).toBe("it-im_nicola");
    expect(pickVoiceForLang("ja", 0.95, "darwin", "arm64")).toBe("ja-jm_kumo");
    expect(pickVoiceForLang("pt-BR", 0.95, "darwin", "arm64")).toBe("pt-pm_alex");
    expect(pickVoiceForLang("zh-Hans", 0.95, "darwin", "arm64")).toBe("zh-zm_yunjian");
  });

  it("does not auto-route Kokoro-only languages on non-darwin", () => {
    expect(pickVoiceForLang("es", 0.95, "linux")).toBeUndefined();
    expect(pickVoiceForLang("ja", 0.95, "win32")).toBeUndefined();
  });

  it("does not auto-route multilingual Kokoro on Intel macOS (no FluidAudio voice pack)", () => {
    expect(pickVoiceForLang("es", 0.95, "darwin", "x64")).toBeUndefined();
    expect(pickVoiceForLang("ja", 0.95, "darwin", "x64")).toBeUndefined();
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
    expect(pickVoiceForLang("fr", 0.95)).toBeUndefined();
    expect(pickVoiceForLang("de", 0.95)).toBeUndefined();
  });

  it("returns undefined when code is missing", () => {
    expect(pickVoiceForLang(undefined, 0.95)).toBeUndefined();
    expect(pickVoiceForLang("", 0.95)).toBeUndefined();
  });
});
