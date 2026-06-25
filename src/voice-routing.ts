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
 * es/it/pt are male; fr is the documented brand-rule exception
 * (Kokoro v1.0 ships no male French voice).
 */
const ONNX_KOKORO_DEFAULTS: Record<string, string> = {
  es: "es-em_alex",
  fr: "fr-ff_siwis",
  it: "it-im_nicola",
  pt: "pt-pm_alex",
};

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
      return platform === "darwin" ? RU_DARWIN_FALLBACK_VOICE : "ru-vosk-m02";
    default:
      // darwin-arm64: FluidAudio ANE voice pack (full multilingual set).
      if (platform === "darwin" && arch === "arm64") return DARWIN_KOKORO_DEFAULTS[baseCode];
      // ONNX: es/fr/it/pt via CharsiuG2P; hi/ja/zh have no ONNX pack → undefined.
      return ONNX_KOKORO_DEFAULTS[baseCode];
  }
}
