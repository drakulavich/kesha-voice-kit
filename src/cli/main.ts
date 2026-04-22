import { defineCommand } from "citty";
import { detect } from "tinyld";
import { transcribe } from "../lib";
import { detectAudioLanguageEngine, detectTextLanguageEngine } from "../engine";
import type { LangDetectResult } from "../engine";
import { log } from "../log";
import type { TranscribeResult } from "../types";
import {
  formatJsonOutput,
  formatTextOutput,
  formatTranscriptOutput,
  formatVerboseOutput,
} from "../format";
import { formatToonOutput } from "../toon";

const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();

interface MainCommandArgs {
  _: string[];
  json: boolean;
  toon: boolean;
  verbose: boolean;
  debug: boolean;
  vad: boolean;
  format?: string;
  lang?: string;
}

export function detectLanguage(text: string): string {
  if (!text) return "";
  return detect(text);
}

export function checkLanguageMismatch(expected: string | undefined, detected: string): string | null {
  if (!expected || !detected || expected === detected) return null;
  return `warning: expected language "${expected}" but detected "${detected}"`;
}

export const mainCommand = defineCommand({
  meta: {
    name: "kesha",
    version: pkg.version,
    description:
      "Kesha Voice Kit — open-source voice toolkit for Apple Silicon.\n" +
      "  Run 'kesha install [--no-cache]' to download engine and models.\n" +
      "  Run 'kesha status' to inspect installed backend.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output results as JSON",
      default: false,
    },
    toon: {
      type: "boolean",
      description: "Output results as TOON (compact, LLM-friendly encoding of the same data as --json)",
      default: false,
    },
    verbose: {
      type: "boolean",
      description: "Show language detection details",
      default: false,
    },
    format: {
      type: "string",
      description: "Output format: transcript (enriched text with lang/confidence)",
    },
    lang: {
      type: "string",
      description: "Expected language code (ISO 639-1), warn if mismatch",
    },
    debug: {
      type: "boolean",
      description: "Trace engine subprocess calls on stderr (or KESHA_DEBUG=1)",
      default: false,
    },
    vad: {
      type: "boolean",
      description: "Run Silero VAD preprocessing for long/silence-heavy audio (opt-in; kesha install --vad first)",
      default: false,
    },
  },
  async run({ args }: { args: MainCommandArgs }) {
    if (args.debug) log.debugEnabled = true;
    const files = args._;

    if ((args.json || args.format === "json") && args.toon) {
      log.error("--json and --toon are mutually exclusive (pick one output format).");
      process.exit(2);
    }

    if (files.length === 0) {
      log.info("Usage: kesha <audio_file> [audio_file ...]\n       kesha install [--no-cache]\n       kesha status");
      process.exit(1);
    }

    let hasError = false;
    const results: TranscribeResult[] = [];

    const wantsLangId = !!(args.lang || args.verbose || args.json || args.toon || args.format === "transcript" || args.format === "json");

    for (const file of files) {
      const startedAt = performance.now();
      try {
        // Run audio lang-id and transcription concurrently
        const [audioResult, text] = await Promise.all([
          wantsLangId ? detectAudioLanguageEngine(file) : Promise.resolve(null),
          transcribe(file, { vad: args.vad }),
        ]);

        let audioLanguage: LangDetectResult | undefined;
        if (audioResult && audioResult.code) {
          audioLanguage = audioResult;
        }

        if (audioLanguage && args.lang && audioLanguage.confidence > 0.8) {
          const mismatch = checkLanguageMismatch(args.lang, audioLanguage.code);
          if (mismatch) log.warn(`${file}: ${mismatch} (from audio)`);
        }

        const tinyldLang = wantsLangId ? detectLanguage(text) : "";
        let textLanguage: LangDetectResult | undefined;

        if (wantsLangId) {
          const engineTextResult = await detectTextLanguageEngine(text);
          if (engineTextResult && engineTextResult.code) {
            textLanguage = engineTextResult;
          }
        }

        const lang = textLanguage?.code || tinyldLang;

        const mismatchWarning = checkLanguageMismatch(args.lang, lang);
        if (mismatchWarning) log.warn(`${file}: ${mismatchWarning}`);

        results.push({
          file,
          text,
          lang,
          audioLanguage,
          textLanguage: textLanguage ?? (tinyldLang ? { code: tinyldLang, confidence: 0 } : undefined),
          sttTimeMs: Math.round(performance.now() - startedAt),
        });
      } catch (err: unknown) {
        hasError = true;
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${file}: ${message}`);
      }
    }

    if (args.json || args.format === "json") {
      process.stdout.write(formatJsonOutput(results));
    } else if (args.toon) {
      process.stdout.write(formatToonOutput(results));
    } else if (args.format === "transcript") {
      process.stdout.write(formatTranscriptOutput(results));
    } else if (args.verbose) {
      process.stdout.write(formatVerboseOutput(results));
    } else {
      process.stdout.write(formatTextOutput(results));
    }

    if (hasError) process.exit(1);
  },
});
