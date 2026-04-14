#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { detect } from "tinyld";
import { transcribe } from "./lib";
import { downloadEngine } from "./engine-install";
import { detectAudioLanguageEngine, detectTextLanguageEngine } from "./engine";
import type { LangDetectResult } from "./engine";
import { log } from "./log";
import { showStatus } from "./status";

export function detectLanguage(text: string): string {
  if (!text) return "";
  return detect(text);
}

export function checkLanguageMismatch(expected: string | undefined, detected: string): string | null {
  if (!expected || !detected || expected === detected) return null;
  return `warning: expected language "${expected}" but detected "${detected}"`;
}

interface InstallCommandArgs {
  "no-cache": boolean;
}

interface MainCommandArgs {
  _: string[];
  json: boolean;
  verbose: boolean;
  lang?: string;
}

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();

async function performInstall(noCache: boolean) {
  try {
    await downloadEngine(noCache);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    process.exit(1);
  }
}

export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Download inference engine and models",
  },
  args: {
    "no-cache": {
      type: "boolean",
      description: "Re-download even if cached",
      default: false,
    },
  },
  async run({ args }: { args: InstallCommandArgs }) {
    await performInstall(args["no-cache"]);
  },
});

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show backend installation status",
  },
  async run() {
    await showStatus();
  },
});

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
    verbose: {
      type: "boolean",
      description: "Show language detection details",
      default: false,
    },
    lang: {
      type: "string",
      description: "Expected language code (ISO 639-1), warn if mismatch",
    },
  },
  async run({ args }: { args: MainCommandArgs }) {
    const files = args._;

    if (files.length === 0) {
      log.info("Usage: kesha <audio_file> [audio_file ...]\n       kesha install [--no-cache]\n       kesha status");
      process.exit(1);
    }

    let hasError = false;
    const results: TranscribeResult[] = [];

    const wantsLangId = !!(args.lang || args.verbose || args.json);

    for (const file of files) {
      try {
        let audioLanguage: LangDetectResult | undefined;
        if (wantsLangId) {
          const audioResult = await detectAudioLanguageEngine(file);
          if (audioResult && audioResult.code) {
            audioLanguage = audioResult;
          }
        }

        if (audioLanguage && args.lang && audioLanguage.confidence > 0.8) {
          const mismatch = checkLanguageMismatch(args.lang, audioLanguage.code);
          if (mismatch) log.warn(`${file}: ${mismatch} (from audio)`);
        }

        const text = await transcribe(file);

        const tinyldLang = detectLanguage(text);
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
        });
      } catch (err: unknown) {
        hasError = true;
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${file}: ${message}`);
      }
    }

    if (args.json) {
      process.stdout.write(formatJsonOutput(results));
    } else if (args.verbose) {
      process.stdout.write(formatVerboseOutput(results));
    } else {
      process.stdout.write(formatTextOutput(results));
    }

    if (hasError) process.exit(1);
  },
});

export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  const [firstArg, ...restArgs] = rawArgs;

  if (firstArg === "install") {
    await runMain(installCommand, { rawArgs: restArgs });
    return;
  }

  if (firstArg === "status") {
    await runMain(statusCommand, { rawArgs: restArgs });
    return;
  }

  await runMain(mainCommand, { rawArgs });
}

export type TranscribeResult = {
  file: string;
  text: string;
  lang: string;
  audioLanguage?: LangDetectResult;
  textLanguage?: LangDetectResult;
};

export function formatTextOutput(results: TranscribeResult[]): string {
  if (results.length === 1) {
    return results[0].text + "\n";
  }
  return results
    .map((r, i) => (i > 0 ? "\n" : "") + `=== ${r.file} ===\n${r.text}\n`)
    .join("");
}

export function formatVerboseOutput(results: TranscribeResult[]): string {
  return results
    .map((r, i) => {
      const lines: string[] = [];
      if (results.length > 1) {
        if (i > 0) lines.push("");
        lines.push(`=== ${r.file} ===`);
      }
      if (r.audioLanguage) {
        lines.push(`Audio language: ${r.audioLanguage.code} (confidence: ${r.audioLanguage.confidence.toFixed(2)})`);
      }
      const textLang = r.textLanguage ?? (r.lang ? { code: r.lang, confidence: 0 } : null);
      if (textLang) {
        const confStr = textLang.confidence > 0 ? ` (confidence: ${textLang.confidence.toFixed(2)})` : "";
        lines.push(`Text language: ${textLang.code}${confStr}`);
      }
      lines.push("---");
      lines.push(r.text);
      return lines.join("\n");
    })
    .join("\n") + "\n";
}

export function formatJsonOutput(results: TranscribeResult[]): string {
  return JSON.stringify(results, null, 2) + "\n";
}

if (import.meta.main) {
  await runCli();
}
