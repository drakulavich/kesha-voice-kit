import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VOICE_ID, pickVoiceForLang } from "../../src/voice-routing";
import { rustModelsSource } from "../helpers/rust-models-source";

const rustSource = (...parts: string[]) =>
  readFileSync(join(import.meta.dir, "..", "..", "rust", "src", ...parts), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const MODELS_RS = rustModelsSource().replace(/\r\n/g, "\n");

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

  it("falls back to ru-vosk-m02 for Russian on non-darwin (Vosk replaces Piper-ruslan, #214)", () => {
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

  // The routing-completeness guards below force a route to *exist*; nothing forced it to be male,
  // so a new language could arrive with a female default and pass the whole suite (#791).
  // CLAUDE.md's exceptions are situational, so they are keyed by the route, not the voice id:
  // `fr-ff_siwis` is fine for French and nowhere else (#792 review).
  const FEMALE_BY_DESIGN: Record<string, string> = {
    "linux-x64 fr -> fr-ff_siwis": "Kokoro v1.0 ships no male French voice",
    "win32-x64 fr -> fr-ff_siwis": "Kokoro v1.0 ships no male French voice",
    "darwin-x64 fr -> fr-ff_siwis": "Kokoro v1.0 ships no male French voice",
    "darwin-arm64 fr -> fr-ff_siwis": "Kokoro v1.0 ships no male French voice",
    "darwin-arm64 ru -> macos-com.apple.voice.compact.ru-RU.Milena":
      "darwin ru is the zero-install path",
    "darwin-x64 ru -> macos-com.apple.voice.compact.ru-RU.Milena":
      "darwin ru is the zero-install path",
  };
  // AVSpeech ids carry no gender, so every macos-* default has to declare one here.
  const AVSPEECH_GENDER: Record<string, "male" | "female"> = {
    "macos-com.apple.voice.compact.ru-RU.Milena": "female",
  };
  // Kokoro spells gender as the letter before `_`; Vosk as m/f before the number.
  const genderOf = (id: string): "male" | "female" | undefined => {
    if (id.startsWith("macos-")) return AVSPEECH_GENDER[id];
    if (/-[a-z]m_/.test(id) || /-m\d+$/.test(id)) return "male";
    if (/-[a-z]f_/.test(id) || /-f\d+$/.test(id)) return "female";
    return undefined;
  };

  it("keeps the documented female routes to the ones CLAUDE.md argues for", () => {
    // A third exception is a brand decision that belongs in CLAUDE.md, not an append here.
    expect(Object.keys(FEMALE_BY_DESIGN).sort()).toEqual([
      "darwin-arm64 fr -> fr-ff_siwis",
      "darwin-arm64 ru -> macos-com.apple.voice.compact.ru-RU.Milena",
      "darwin-x64 fr -> fr-ff_siwis",
      "darwin-x64 ru -> macos-com.apple.voice.compact.ru-RU.Milena",
      "linux-x64 fr -> fr-ff_siwis",
      "win32-x64 fr -> fr-ff_siwis",
    ]);
  });

  it("routes every advertised language to a male voice, bar the documented exceptions", () => {
    const platforms = [
      ["darwin", "arm64", advertisedTtsLangs().systemKokoro],
      ["linux", "x64", advertisedTtsLangs().onnx],
      ["win32", "x64", advertisedTtsLangs().onnx],
      ["darwin", "x64", advertisedTtsLangs().onnx],
    ] as const;

    const offenders: string[] = [];
    for (const [platform, arch, langs] of platforms) {
      for (const lang of langs) {
        const voice = pickVoiceForLang(lang, 0.95, platform, arch);
        if (voice === undefined) continue;
        const gender = genderOf(voice);
        // `undefined` is an offender too: an unclassifiable default must be declared, not assumed.
        const route = `${platform}-${arch} ${lang} -> ${voice}`;
        if (gender === "male" || route in FEMALE_BY_DESIGN) continue;
        offenders.push(`${route} (${gender ?? "unclassified"})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Both exceptions are deliberate; this fails if someone "fixes" one of them (CLAUDE.md).
  it("keeps the two documented female routes exactly where they are", () => {
    expect(pickVoiceForLang("fr", 0.95, "linux", "x64")).toBe("fr-ff_siwis");
    expect(pickVoiceForLang("ru", 0.95, "darwin", "arm64")).toBe(
      "macos-com.apple.voice.compact.ru-RU.Milena",
    );
    expect(pickVoiceForLang("ru", 0.95, "linux", "x64")).toBe("ru-vosk-m02");
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

// The MCP server names this voice when routing declines, and reports it as the one that
// spoke (#942). Two things have to hold for that report to stay true, so both are parsed
// out of the Rust source rather than copied: the constant's value, and the fact that
// `kesha-engine say` still applies *that* constant when no --voice reaches it.
describe("DEFAULT_VOICE_ID", () => {
  it("matches the engine's fallback voice", () => {
    const engineDefault = rustSource("tts", "voices.rs").match(
      /DEFAULT_VOICE_ID:\s*&str\s*=\s*"([^"]+)"/,
    )?.[1];
    expect(engineDefault).toBe(DEFAULT_VOICE_ID);
  });

  it("is what the engine's own say applies when no voice reaches it", () => {
    const fallback = rustSource("cli", "say.rs").match(/voice_id\.unwrap_or\(([^)]*)\)/)?.[1];
    expect(fallback).toBe("tts::voices::DEFAULT_VOICE_ID");
  });
});
