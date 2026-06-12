/**
 * Darwin defaults to AVSpeech Milena — zero install, no model download required.
 * Linux/Windows fall through to Vosk-TTS `ru-vosk-m02` (male, per CLAUDE.md
 * "DEFAULT TTS VOICES MUST BE MALE"; replaces Piper-ruslan as of #213).
 */
const RU_DARWIN_FALLBACK_VOICE = "macos-com.apple.voice.compact.ru-RU.Milena";

const DARWIN_KOKORO_DEFAULTS: Record<string, string> = {
  es: "es-em_alex",
  hi: "hi-hm_omega",
  it: "it-im_nicola",
  ja: "ja-jm_kumo",
  pt: "pt-pm_alex",
  zh: "zh-zm_050",
};

/**
 * ONNX-platform (Linux / Windows / Intel macOS) multilingual defaults.
 * These mirror the Rust `default_voice_for_lang` in the engine.
 * es/it/pt are male; fr is the documented brand-rule exception
 * (Kokoro v1.0 ships no male French voice).
 */
const ONNX_KOKORO_DEFAULTS: Record<string, string> = {
  es: "es-em_alex",
  fr: "fr-ff_siwis",
  it: "it-im_nicola",
  pt: "pt-pm_alex",
};

/** Map a detected language code to a default voice id. Unknown / low-confidence → undefined. */
export function pickVoiceForLang(
  code: string | undefined,
  confidence: number,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  if (!code || confidence < 0.5) return undefined;
  const baseCode = code.toLowerCase().split(/[-_]/, 1)[0];
  switch (baseCode) {
    case "en":
      return "en-am_michael";
    case "ru":
      // AVSpeech Milena is a macOS system voice (any arch); Vosk elsewhere.
      return platform === "darwin" ? RU_DARWIN_FALLBACK_VOICE : "ru-vosk-m02";
    default:
      // darwin-arm64: FluidAudio ANE voice pack (full multilingual set).
      if (platform === "darwin" && arch === "arm64") return DARWIN_KOKORO_DEFAULTS[baseCode];
      // ONNX platforms (Linux, Windows, Intel macOS): es/fr/it/pt are supported
      // via CharsiuG2P + ONNX Kokoro. Other languages (hi, ja, zh, …) have no
      // ONNX voice pack, so fall through to the engine default (undefined).
      return ONNX_KOKORO_DEFAULTS[baseCode];
  }
}
