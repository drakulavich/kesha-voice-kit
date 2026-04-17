#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { detect } from "tinyld";
import { transcribe } from "./lib";
import { downloadEngine } from "./engine-install";
import { detectAudioLanguageEngine, detectTextLanguageEngine } from "./engine";
import type { LangDetectResult } from "./engine";
import { log } from "./log";
import { say, SayError } from "./say";
import { showStatus } from "./status";
import { suggestCommand } from "./suggest-command";

export function detectLanguage(text: string): string {
  if (!text) return "";
  return detect(text);
}

export function checkLanguageMismatch(expected: string | undefined, detected: string): string | null {
  if (!expected || !detected || expected === detected) return null;
  return `warning: expected language "${expected}" but detected "${detected}"`;
}

interface InstallCommandArgs {
  coreml: boolean;
  onnx: boolean;
  "no-cache": boolean;
  tts: boolean;
}

interface MainCommandArgs {
  _: string[];
  json: boolean;
  verbose: boolean;
  lang?: string;
}

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();

function resolveBackendFlag(coreml: boolean, onnx: boolean): string | undefined {
  if (coreml && onnx) {
    log.error('Choose only one backend: "--coreml" or "--onnx".');
    process.exit(1);
  }
  if (coreml) return "coreml";
  if (onnx) return "onnx";
  return undefined;
}

async function performInstall(noCache: boolean, backend?: string, tts = false) {
  try {
    await downloadEngine(noCache, backend, { tts });
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
    tts: {
      type: "boolean",
      description: "Also install Kokoro TTS models (~326MB, requires espeak-ng on PATH)",
      default: false,
    },
  },
  async run({ args }: { args: InstallCommandArgs }) {
    const backend = resolveBackendFlag(args.coreml, args.onnx);
    await performInstall(args["no-cache"], backend, args.tts);
  },
});

export const sayCommand = defineCommand({
  meta: {
    name: "say",
    description: "Synthesize speech from text (TTS). Writes WAV to stdout (or --out file).",
  },
  args: {
    text: { type: "positional", required: false, description: "Text to speak (stdin if omitted)" },
    voice: { type: "string", description: "Voice id, e.g. en-af_heart" },
    lang: { type: "string", description: "espeak language code (default en-us)" },
    out: { type: "string", description: "Write WAV to file instead of stdout" },
    rate: { type: "string", description: "Speaking rate 0.5–2.0", default: "1.0" },
    "list-voices": { type: "boolean", description: "List installed voices and exit" },
  },
  async run({ args }) {
    const text = typeof args.text === "string" ? args.text : undefined;
    const opts = {
      text,
      voice: typeof args.voice === "string" ? args.voice : undefined,
      lang: typeof args.lang === "string" ? args.lang : undefined,
      out: typeof args.out === "string" ? args.out : undefined,
      rate: args.rate ? Number(args.rate) : undefined,
    };

    if (args["list-voices"]) {
      // The engine prints the list directly — just relay its stdout + exit code.
      const { getEngineBinPath } = await import("./engine");
      const proc = Bun.spawn([getEngineBinPath(), "say", "--list-voices"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await proc.exited);
    }

    try {
      // If no text and no stdin, engine reads empty and exits 2. Pipe stdin through.
      const wav = await sayCliPassthrough(opts, text);
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

/**
 * When the CLI user omits the positional text, they may be piping into stdin
 * (e.g. `echo hi | kesha say > out.wav`). `say()` in src/say.ts already handles
 * the stdin case, but we must not close stdin prematurely — forward the terminal's
 * stdin to the engine. Currently `say()` only writes a provided string; for stdin
 * piping we'd duplicate that here. For M1, require the text arg or stdin via pipe
 * that the user set up on the engine directly; keep `say()` the primary path.
 */
async function sayCliPassthrough(
  opts: Parameters<typeof say>[0],
  inlineText: string | undefined,
): Promise<Uint8Array> {
  // If inline text given, use the normal say() helper.
  if (inlineText !== undefined && inlineText.length > 0) {
    return say(opts);
  }
  // Otherwise, read stdin in the CLI process, hand to engine via stdin.
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
  const stdinText = new TextDecoder().decode(merged).trim();
  return say({ ...opts, text: stdinText });
}

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
        // Run audio lang-id and transcription concurrently
        const [audioResult, text] = await Promise.all([
          wantsLangId ? detectAudioLanguageEngine(file) : Promise.resolve(null),
          transcribe(file),
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

const SUBCOMMANDS = ["install", "status", "say"];

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

  if (firstArg === "say") {
    await runMain(sayCommand, { rawArgs: restArgs });
    return;
  }

  // Check for unknown subcommands (non-flag, non-file-path args)
  if (firstArg && !firstArg.startsWith("-") && !firstArg.includes(".") && !firstArg.includes("/")) {
    const suggestion = suggestCommand(firstArg, SUBCOMMANDS);
    if (suggestion && suggestion !== firstArg) {
      log.error(`unknown command '${firstArg}'`);
      log.warn(`(Did you mean ${suggestion}?)`);
      process.exit(1);
    }
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
