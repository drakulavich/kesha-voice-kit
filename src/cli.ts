#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { detect } from "tinyld";
import { transcribe } from "./lib";
import { downloadModel } from "./onnx-install";
import { downloadCoreML } from "./coreml-install";
import { isMacArm64 } from "./coreml";
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

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();

async function performInstall(options: { coreml: boolean; onnx: boolean; noCache: boolean }) {
  const { coreml, onnx, noCache } = options;
  try {
    if (coreml) {
      if (!isMacArm64()) {
        log.error("CoreML backend is only available on macOS Apple Silicon.");
        process.exit(1);
      }
      await downloadCoreML(noCache);
    } else if (onnx) {
      await downloadModel(noCache);
    } else if (isMacArm64()) {
      await downloadCoreML(noCache);
    } else {
      await downloadModel(noCache);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    process.exit(1);
  }
}

export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Download speech-to-text models",
  },
  args: {
    coreml: {
      type: "boolean",
      description: "Force CoreML backend (macOS arm64)",
      default: false,
    },
    onnx: {
      type: "boolean",
      description: "Force ONNX backend",
      default: false,
    },
    "no-cache": {
      type: "boolean",
      description: "Re-download even if cached",
      default: false,
    },
  },
  async run({ args }) {
    await performInstall({ coreml: args.coreml, onnx: args.onnx, noCache: args["no-cache"] });
  },
});

export const mainCommand = defineCommand({
  meta: {
    name: "parakeet",
    version: pkg.version,
    description:
      "Fast local speech-to-text. 25 languages. CoreML on Apple Silicon, ONNX on CPU.\n" +
      "  Run 'parakeet install [--coreml | --onnx] [--no-cache]' to download models.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output results as JSON",
      default: false,
    },
    lang: {
      type: "string",
      description: "Expected language code (ISO 639-1), warn if mismatch",
    },
  },
  async run({ args }) {
    const positional = args._ as string[];

    // Manual subcommand routing: "parakeet install [flags]"
    if (positional[0] === "install") {
      const argv = process.argv;
      const coreml = argv.includes("--coreml");
      const onnx = argv.includes("--onnx");
      const noCache = argv.includes("--no-cache");
      await performInstall({ coreml, onnx, noCache });
      return;
    }

    if (positional[0] === "status") {
      await showStatus();
      return;
    }

    const files = positional;

    if (files.length === 0) {
      log.info("Usage: parakeet <audio_file> [audio_file ...]\n       parakeet install [--coreml | --onnx] [--no-cache]\n       parakeet status");
      process.exit(1);
    }

    let hasError = false;
    const results: TranscribeResult[] = [];

    for (const file of files) {
      try {
        const text = await transcribe(file);
        const lang = detectLanguage(text);

        const mismatchWarning = checkLanguageMismatch(args.lang, lang);
        if (mismatchWarning) log.warn(`${file}: ${mismatchWarning}`);

        results.push({ file, text, lang });
      } catch (err: unknown) {
        hasError = true;
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${file}: ${message}`);
      }
    }

    if (args.json) {
      process.stdout.write(formatJsonOutput(results));
    } else {
      process.stdout.write(formatTextOutput(results));
    }

    if (hasError) process.exit(1);
  },
});

export type TranscribeResult = { file: string; text: string; lang: string };

export function formatTextOutput(results: TranscribeResult[]): string {
  if (results.length === 1) {
    return results[0].text + "\n";
  }
  return results
    .map((r, i) => (i > 0 ? "\n" : "") + `=== ${r.file} ===\n${r.text}\n`)
    .join("");
}

export function formatJsonOutput(results: TranscribeResult[]): string {
  return JSON.stringify(results, null, 2) + "\n";
}

if (import.meta.main) {
  runMain(mainCommand);
}
