import { detectTextLanguageEngine } from "./engine";

/** The voice the Engine speaks with when `say` is given no `--voice` — mirrors `tts::voices::DEFAULT_VOICE_ID`. */
export const DEFAULT_VOICE_ID = "en-am_michael";

/**
 * Darwin defaults to AVSpeech Milena — zero install, no model download required.
 * Linux/Windows fall through to Vosk-TTS `ru-vosk-m02` (male, per CLAUDE.md
 * "DEFAULT TTS VOICES MUST BE MALE"; replaces Piper-ruslan as of #214).
 */
const RU_DARWIN_FALLBACK_VOICE = "macos-com.apple.voice.compact.ru-RU.Milena";

/**
 * darwin-arm64 (FluidAudio ANE voice pack) defaults. This table plus the
 * `en`/`ru` switch arms must together cover every code `tts_languages()`
 * advertises on a system_kokoro build — a missing entry silently drops
 * `--voice` and the engine falls back to English (#769).
 * fr is the documented brand-rule exception (no male French voice in Kokoro v1.0).
 */
const DARWIN_KOKORO_DEFAULTS: Record<string, string> = {
  es: "es-em_alex",
  fr: "fr-ff_siwis",
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
  const baseCode = code.toLowerCase().split(/[-_]/, 1)[0] ?? "";
  switch (baseCode) {
    case "en":
      return DEFAULT_VOICE_ID;
    case "ru":
      return platform === "darwin" ? RU_DARWIN_FALLBACK_VOICE : "ru-vosk-m02";
    default:
      if (platform === "darwin" && arch === "arm64") return DARWIN_KOKORO_DEFAULTS[baseCode];
      // ONNX: es/fr/it/pt via CharsiuG2P; hi/ja/zh have no ONNX pack → undefined.
      return ONNX_KOKORO_DEFAULTS[baseCode];
  }
}

async function autoRouteVoice(text: string): Promise<string | undefined> {
  if (!text) return undefined;
  const detected = await detectTextLanguageEngine(text);
  return pickVoiceForLang(detected?.code, detected?.confidence ?? 0);
}

/**
 * Resolve the voice for a synthesis request. Precedence: explicit voice >
 * explicit language hint (route by the stated language, skipping detection —
 * also the path on Linux/Windows where text-language detection is unavailable) >
 * macOS text-language auto-detection > engine default (`undefined`). A language
 * hint the build has no voice for resolves to `undefined` (engine default)
 * rather than re-running detection — the user stated the language explicitly.
 */
export async function resolveSayVoice(
  explicitVoice: string | undefined,
  langHint: string | undefined,
  text: string,
): Promise<string | undefined> {
  if (explicitVoice !== undefined) return explicitVoice;
  if (langHint !== undefined) return pickVoiceForLang(langHint, 1);
  return autoRouteVoice(text);
}
