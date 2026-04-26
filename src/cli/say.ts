import { defineCommand } from "citty";
import { detectTextLanguageEngine, getEngineBinPath } from "../engine";
import { log } from "../log";
import { say, SayError } from "../say";

/** Workaround for #207 (Piper `ru-denis` unintelligible) — remove when Piper-ru is fixed. */
const RU_DARWIN_FALLBACK_VOICE = "macos-com.apple.voice.compact.ru-RU.Milena";

/** Map a detected language code to a default voice id. Unknown / low-confidence → undefined. */
export function pickVoiceForLang(
  code: string | undefined,
  confidence: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!code || confidence < 0.5) return undefined;
  switch (code) {
    case "en":
      return "en-af_heart";
    case "ru":
      return platform === "darwin" ? RU_DARWIN_FALLBACK_VOICE : "ru-denis";
    default:
      return undefined;
  }
}

/** Run NLLanguageRecognizer (via engine) on the text and pick a default voice. */
async function autoRouteVoice(text: string): Promise<string | undefined> {
  if (!text) return undefined;
  const detected = await detectTextLanguageEngine(text);
  return pickVoiceForLang(detected?.code, detected?.confidence ?? 0);
}

/** Resolve the text to synthesize: inline positional, else read from stdin. */
async function resolveText(inline: string | undefined): Promise<string> {
  if (inline !== undefined && inline.length > 0) return inline;
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged).trim();
}

export const sayCommand = defineCommand({
  meta: {
    name: "say",
    description: "Synthesize speech from text (TTS). Writes WAV to stdout (or --out file).",
  },
  args: {
    text: { type: "positional", required: false, description: "Text to speak (stdin if omitted)" },
    voice: { type: "string", description: "Voice id, e.g. en-af_heart" },
    lang: { type: "string", description: "BCP 47 language code (default en-us)" },
    out: { type: "string", description: "Write WAV to file instead of stdout" },
    rate: { type: "string", description: "Speaking rate 0.5–2.0", default: "1.0" },
    "list-voices": { type: "boolean", description: "List installed voices and exit" },
    ssml: {
      type: "boolean",
      description: "Parse input as SSML (supports <speak>, <break>; strips unknown tags)",
    },
    verbose: {
      type: "boolean",
      description: "Log TTS synthesis time to stderr",
      default: false,
    },
    debug: {
      type: "boolean",
      description: "Trace engine subprocess calls on stderr (or KESHA_DEBUG=1)",
      default: false,
    },
  },
  async run({ args }) {
    if (args.debug) log.debugEnabled = true;
    if (args["list-voices"]) {
      // The engine prints the list directly — just relay its stdout + exit code.
      const proc = Bun.spawn([getEngineBinPath(), "say", "--list-voices"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await proc.exited);
    }

    const inlineText = typeof args.text === "string" ? args.text : undefined;
    const text = await resolveText(inlineText);
    const explicitVoice = typeof args.voice === "string" ? args.voice : undefined;
    const voice = explicitVoice ?? (await autoRouteVoice(text));

    const opts = {
      text,
      voice,
      lang: typeof args.lang === "string" ? args.lang : undefined,
      out: typeof args.out === "string" ? args.out : undefined,
      rate: args.rate ? Number(args.rate) : undefined,
      ssml: Boolean(args.ssml),
    };

    try {
      const startedAt = performance.now();
      const wav = await say(opts);
      const ttsTimeMs = Math.round(performance.now() - startedAt);
      if (args.verbose) {
        // stderr — stdout may carry raw WAV bytes when --out is omitted.
        console.error(`TTS time: ${ttsTimeMs}ms`);
      }
      if (!opts.out) {
        process.stdout.write(wav);
      }
    } catch (err) {
      if (err instanceof SayError) {
        log.error(err.stderr.trim() || err.message);
        process.exit(err.exitCode);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(message);
      process.exit(4);
    }
  },
});
