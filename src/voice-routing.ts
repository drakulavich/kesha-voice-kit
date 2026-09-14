import { detectTextLanguageEngine } from "./engine";
import { listVoiceIds } from "./synth";

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

interface NativeScriptRoute {
  /** AVSpeech locale as it appears in a `macos-*` voice id. */
  locale: string;
  /** Apple's male voice for the locale, preferred at any quality variant (CLAUDE.md brand rule). */
  preferredName: string;
  script: RegExp;
}

/**
 * The Kokoro packs for these two languages accept Latin input only, so native-script text
 * routed to them can only ever be refused (T2-10). AVSpeech reads both scripts natively.
 */
const NATIVE_SCRIPT_ROUTES: Record<string, NativeScriptRoute> = {
  hi: { locale: "hi-IN", preferredName: "Rishi", script: /[ऀ-ॿ]/u },
  ja: {
    locale: "ja-JP",
    preferredName: "Otoya",
    script: /[぀-ヿ㐀-䶿一-鿿]/u,
  },
};

const LATIN_LETTER = /[A-Za-z]/u;

/** True when more of the text's letters are in `script` than in the Latin alphabet. */
function dominantScript(text: string, script: RegExp): boolean {
  let native = 0;
  let latin = 0;
  for (const ch of text) {
    if (script.test(ch)) native++;
    else if (LATIN_LETTER.test(ch)) latin++;
  }
  return native > latin;
}

/** The male voice for the locale at any quality variant, else the first one installed. */
function avSpeechVoiceFor(voices: string[], route: NativeScriptRoute): string | undefined {
  const forLocale = voices.filter(
    (id) => id.startsWith("macos-") && id.includes(`.${route.locale}.`),
  );
  return forLocale.find((id) => id.endsWith(`.${route.preferredName}`)) ?? forLocale[0];
}

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

export interface ResolveSayVoiceOptions {
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** The engine's `say --list-voices` union; injected so the routing decision is testable without an engine. */
  listVoices?: (signal?: AbortSignal) => Promise<string[]>;
}

function baseLangOf(code: string | undefined): string {
  return (code ?? "").toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

/**
 * Swaps a Kokoro voice that cannot phonemize the text's script for an installed AVSpeech
 * voice that can. Any failure keeps the Kokoro voice, so the engine still refuses with its
 * own hint rather than this silently changing what spoke.
 */
async function nativeScriptOverride(
  lang: string,
  text: string,
  options: ResolveSayVoiceOptions,
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return undefined;
  const route = NATIVE_SCRIPT_ROUTES[lang];
  if (!route || !dominantScript(text, route.script)) return undefined;
  try {
    const voices = options.listVoices
      ? await options.listVoices(options.signal)
      : await listVoiceIds({}, options.signal);
    return avSpeechVoiceFor(voices, route);
  } catch {
    return undefined;
  }
}

async function detectLang(
  text: string,
  options: ResolveSayVoiceOptions,
): Promise<{ code?: string; confidence: number }> {
  if (!text) return { confidence: 0 };
  const detected = await detectTextLanguageEngine(text, { signal: options.signal });
  return { code: detected?.code, confidence: detected?.confidence ?? 0 };
}

/**
 * Resolve the voice for a synthesis request. Precedence: explicit voice >
 * explicit language hint (route by the stated language, skipping detection —
 * also the path on Linux/Windows where text-language detection is unavailable) >
 * macOS text-language auto-detection > engine default (`undefined`). A language
 * hint the build has no voice for resolves to `undefined` (engine default)
 * rather than re-running detection — the user stated the language explicitly.
 *
 * This is the one routing point that sees the text, so it is where `ja`/`hi` in their
 * native script leave the Latin-only Kokoro packs for AVSpeech (T2-10).
 */
export async function resolveSayVoice(
  explicitVoice: string | undefined,
  langHint: string | undefined,
  text: string,
  options: ResolveSayVoiceOptions = {},
): Promise<string | undefined> {
  if (explicitVoice !== undefined) return explicitVoice;
  const { code, confidence } =
    langHint !== undefined ? { code: langHint, confidence: 1 } : await detectLang(text, options);
  const voice = pickVoiceForLang(code, confidence, options.platform, options.arch);
  if (confidence < 0.5) return voice;
  return (await nativeScriptOverride(baseLangOf(code), text, options)) ?? voice;
}
