import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickVoiceForLang } from "../../src/voice-routing";

const MODELS_RS = readFileSync(
  join(import.meta.dir, "..", "..", "rust", "src", "models.rs"),
  "utf8",
).replace(/\r\n/g, "\n");

// Parsed, not copied: a language added to tts_languages() alone must turn these guards red (#769).
function advertisedTtsLangs(): { systemKokoro: string[]; onnx: string[] } {
  const body = MODELS_RS.match(/pub fn tts_languages\(\)[^{]*\{\n([\s\S]*?)\n\}/)?.[1];
  const arms = body ? [...body.matchAll(/#\[cfg\((not\()?[\s\S]*?vec!\[([^\]]*)\]/g)] : [];
  const langsOf = (negated: boolean) =>
    [...(arms.find((m) => Boolean(m[1]) === negated)?.[2] ?? "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
  const systemKokoro = langsOf(false);
  const onnx = langsOf(true);
  if (systemKokoro.length === 0 || onnx.length === 0) {
    throw new Error("could not parse tts_languages() — did rust/src/models.rs change shape?");
  }
  return { systemKokoro, onnx };
}

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

  it("routes supported Kokoro languages on darwin-arm64 (male defaults; fr is the documented female exception)", () => {
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
    const unrouted = advertisedTtsLangs().systemKokoro.filter(
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
      const unrouted = advertisedTtsLangs().onnx.filter(
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
