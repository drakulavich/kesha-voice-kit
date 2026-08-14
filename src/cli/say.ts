import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import {
  getEngineBinPath,
  isEngineInstalled,
  spawnEngineProcess,
  spawnStdioWithDebugFd,
} from "../engine";
import { installHint } from "../install-hint";
import { registerProcessTree } from "../process-tree";
import { log } from "../log";
import {
  say,
  SayError,
  SUPPORTED_SAMPLE_RATES,
  type SayFormat,
  type SayOptions,
} from "../synth";
import { artifactFromBytes, artifactFromFile, type StatsRecorder } from "../stats";
import { resolveSayVoice } from "../voice-routing";
import { diagnosticCharBucket, diagnosticSizeBucket } from "../diagnostic-events";
import { runCommandSession, type CommandOutcome, type CommandSession } from "./command-session";

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

export function shouldRejectMissingSayText(
  inlineText: string | undefined,
  stdinIsTty: boolean | undefined,
): boolean {
  return (inlineText === undefined || inlineText.length === 0) && stdinIsTty === true;
}

type Parsed<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

function parseFiniteNumberFlag(name: string, value: unknown): Parsed<number> {
  if (value === undefined || value === null || value === false) return { ok: true, value: undefined };
  const raw = String(value).trim();
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed)) {
    return { ok: false, error: `${name} must be a finite number.` };
  }
  return { ok: true, value: parsed };
}

function parseRateFlag(value: unknown): Parsed<number> {
  const rate = parseFiniteNumberFlag("--rate", value);
  if (!rate.ok || rate.value === undefined) return rate;
  if (rate.value < 0.5 || rate.value > 2.0) {
    return { ok: false, error: "--rate must be between 0.5 and 2.0." };
  }
  return rate;
}

function parseBitrateFlag(value: unknown): Parsed<number> {
  const bitrate = parseFiniteNumberFlag("--bitrate", value);
  if (!bitrate.ok || bitrate.value === undefined) return bitrate;
  if (!Number.isInteger(bitrate.value) || bitrate.value <= 0) {
    return { ok: false, error: "--bitrate must be a positive integer." };
  }
  return bitrate;
}

function parseSampleRateFlag(value: unknown): Parsed<number> {
  const sampleRate = parseFiniteNumberFlag("--sample-rate", value);
  if (!sampleRate.ok || sampleRate.value === undefined) return sampleRate;
  if (
    !Number.isInteger(sampleRate.value) ||
    !SUPPORTED_SAMPLE_RATES.includes(sampleRate.value as (typeof SUPPORTED_SAMPLE_RATES)[number])
  ) {
    return {
      ok: false,
      error: `--sample-rate must be one of ${SUPPORTED_SAMPLE_RATES.join(", ")}.`,
    };
  }
  return sampleRate;
}

function parseFormatFlag(raw: unknown): Parsed<SayFormat> {
  if (typeof raw !== "string" || raw === "") return { ok: true, value: undefined };
  const lower = raw.toLowerCase();
  if (lower === "wav" || lower === "ogg-opus" || lower === "flac") return { ok: true, value: lower };
  if (lower === "opus" || lower === "ogg") return { ok: true, value: "ogg-opus" };
  return { ok: false, error: `unknown --format '${raw}'. supported: wav, ogg-opus, flac` };
}

function checkOpusOnlyFlags(
  bitrate: number | undefined,
  sampleRate: number | undefined,
  format: SayFormat | undefined,
  outArg: string | undefined,
): string | null {
  if (bitrate === undefined && sampleRate === undefined) return null;
  const outExt = outArg?.split(".").pop()?.toLowerCase();
  const impliesOpus = outExt !== undefined && ["ogg", "opus", "oga"].includes(outExt);
  // --bitrate / --sample-rate are Opus-only (wav/flac are lossless, no encoder knobs).
  const resolvesToOpus = format === "ogg-opus" || (format === undefined && impliesOpus);
  if (resolvesToOpus) return null;
  return "--bitrate and --sample-rate are only valid with --format ogg-opus";
}

export type SayFlagArgs = {
  format?: unknown;
  rate?: unknown;
  bitrate?: unknown;
  "sample-rate"?: unknown;
  out?: unknown;
};

export type ResolvedSayFlags =
  | {
      ok: true;
      format: SayFormat | undefined;
      rate: number | undefined;
      bitrate: number | undefined;
      sampleRate: number | undefined;
    }
  | { ok: false; error: string };

/** Validates the encoder flags before the engine is spawned: faster failure in scripts (the engine repeats them authoritatively). */
export function resolveSayFlags(args: SayFlagArgs): ResolvedSayFlags {
  const format = parseFormatFlag(args.format);
  if (!format.ok) return format;
  const rate = parseRateFlag(args.rate);
  if (!rate.ok) return rate;
  const bitrate = parseBitrateFlag(args.bitrate);
  if (!bitrate.ok) return bitrate;
  const sampleRate = parseSampleRateFlag(args["sample-rate"]);
  if (!sampleRate.ok) return sampleRate;

  const out = typeof args.out === "string" ? args.out : undefined;
  const opusOnlyError = checkOpusOnlyFlags(bitrate.value, sampleRate.value, format.value, out);
  if (opusOnlyError) return { ok: false, error: opusOnlyError };

  return {
    ok: true,
    format: format.value,
    rate: rate.value,
    bitrate: bitrate.value,
    sampleRate: sampleRate.value,
  };
}

type SayOpts = {
  text: string;
  voice: string | undefined;
  lang: string | undefined;
  out: string | undefined;
  rate: number | undefined;
  ssml: boolean;
  format: SayFormat | undefined;
  bitrate: number | undefined;
  sampleRate: number | undefined;
  noExpandAbbrev: boolean;
};

function recordOutputArtifact(
  stats: StatsRecorder,
  audio: Uint8Array,
  opts: SayOpts,
): { outputFormat: string; outputSizeBytes: number | null | undefined } {
  if (opts.out) {
    const outputArtifact = artifactFromFile(opts.out, "output_audio");
    if (outputArtifact) stats.recordArtifact(outputArtifact);
    return {
      outputFormat: outputArtifact?.format || opts.format || "auto",
      outputSizeBytes: outputArtifact?.sizeBytes,
    };
  }
  stats.recordArtifact(artifactFromBytes(audio.byteLength, "output_audio", opts.format ?? "wav"));
  return { outputFormat: opts.format ?? "wav", outputSizeBytes: audio.byteLength };
}

async function synthesizeAndEmit(
  opts: SayOpts,
  verbose: boolean,
  session: CommandSession,
): Promise<CommandOutcome> {
  const { stats } = session;
  try {
    const startedAt = performance.now();
    if (opts.out) {
      const voiceLabel = opts.voice ?? "default voice";
      log.status(`Synthesizing ${voiceLabel} -> ${opts.out}...`);
    }
    const audio = await stats.timeStage("tts", () => say(opts as SayOptions));
    const ttsTimeMs = Math.round(performance.now() - startedAt);
    if (opts.out) {
      log.status(`Saved ${opts.out} (${ttsTimeMs}ms)`);
    }
    // stderr — stdout may carry raw audio bytes when --out is omitted.
    if (verbose && !opts.out) log.status(`TTS time: ${ttsTimeMs}ms`);
    const { outputFormat, outputSizeBytes } = recordOutputArtifact(stats, audio, opts);
    if (!opts.out) process.stdout.write(audio);
    return {
      status: "success",
      itemCount: 1,
      finishFields: {
        durationMs: ttsTimeMs,
        hasOut: Boolean(opts.out),
        outputFormat,
        outputSizeBucket: diagnosticSizeBucket(outputSizeBytes),
      },
    };
  } catch (err) {
    const code = err instanceof SayError ? err.code : "E_INTERNAL";
    const exitCode = err instanceof SayError ? err.exitCode : 4;
    stats.recordError("tts", err, code);
    log.error(err instanceof SayError ? err.stderr.trim() || err.message : errorMessage(err));
    return {
      status: "failed",
      itemCount: 1,
      exitCode,
      finishFields: {
        errorKind: err instanceof SayError ? "say_error" : "error",
        exitCode,
        error_code: code,
      },
    };
  }
}

export const sayCommand = defineCommand({
  meta: {
    name: "say",
    description:
      "Synthesize speech from text (TTS). Writes audio to stdout (or --out file). Defaults to WAV; use --format ogg-opus for messenger-ready voice notes.",
  },
  args: {
    text: { type: "positional", required: false, description: "Text to speak (stdin if omitted)" },
    voice: { type: "string", description: "Voice id, e.g. en-am_michael" },
    lang: {
      type: "string",
      description:
        "Language code, e.g. en-us (default en-us; see docs/languages.md). With no --voice, routes to that language's default voice and skips text-language detection.",
    },
    out: { type: "string", description: "Write audio to file instead of stdout" },
    rate: { type: "string", description: "Speaking rate 0.5–2.0", default: "1.0" },
    "list-voices": { type: "boolean", description: "List installed voices and exit" },
    ssml: {
      type: "boolean",
      description: "Parse input as SSML (supports <speak>, <break>; strips unknown tags)",
    },
    format: {
      type: "string",
      description:
        "Output format: wav (default), ogg-opus (Telegram-ready voice note), or flac (lossless, plays in all browsers incl. Safari). Inferred from --out extension when omitted.",
    },
    bitrate: {
      type: "string",
      description: "Opus bitrate in bits/sec (e.g. 32000). Only with --format ogg-opus.",
    },
    "sample-rate": {
      type: "string",
      description:
        "Opus encoder sample rate (8000/12000/16000/24000/48000). Only with --format ogg-opus.",
    },
    "no-expand-abbrev": {
      type: "boolean",
      description:
        "Disable acronym auto-expansion on ru-vosk-* voices (ВОЗ → 'вэ о зэ') and English on ONNX engine builds " +
        "(FBI → 'ef bee eye'). No effect on macOS arm64 FluidAudio, macos-* or non-English voices, which spell " +
        "initialisms in their own G2P; the engine warns when the flag is ignored. " +
        "<say-as interpret-as='characters'> still works.",
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
      if (!isEngineInstalled()) {
        log.error(`kesha-engine not installed. run: ${installHint()}`);
        process.exit(1);
      }
      // The engine prints the list directly — just relay its stdout + exit code.
      const proc = spawnEngineProcess(
        getEngineBinPath(),
        ["say", "--list-voices"],
        spawnStdioWithDebugFd(["inherit", "inherit", "inherit"]),
      );
      // Register so a Ctrl-C during a cold Engine load terminates it and exits 130/143 (#939);
      // dispose before the process.exit below so the registration never outlives the run.
      const tree = registerProcessTree(proc);
      let exitCode: number;
      try {
        exitCode = await proc.exited;
      } finally {
        tree.dispose();
      }
      process.exit(exitCode);
    }

    const flags = resolveSayFlags(args);
    if (!flags.ok) {
      log.error(flags.error);
      process.exit(2);
    }

    const inlineText = typeof args.text === "string" ? args.text : undefined;
    const stdinIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    if (shouldRejectMissingSayText(inlineText, stdinIsTty)) {
      log.error("kesha say requires text or piped stdin. Usage: kesha say <text>");
      process.exit(2);
    }
    const text = await resolveText(inlineText);
    const explicitVoice = typeof args.voice === "string" ? args.voice : undefined;
    const langHint = typeof args.lang === "string" ? args.lang : undefined;
    const voice = await resolveSayVoice(explicitVoice, langHint, text);

    const opts: SayOpts = {
      text,
      voice,
      lang: langHint,
      out: typeof args.out === "string" ? args.out : undefined,
      rate: flags.rate,
      ssml: Boolean(args.ssml),
      format: flags.format,
      bitrate: flags.bitrate,
      sampleRate: flags.sampleRate,
      noExpandAbbrev: Boolean(args["no-expand-abbrev"]),
    };

    const outcome = await runCommandSession(
      "say",
      {
        charBucket: diagnosticCharBucket(Array.from(text).length),
        hasInlineInput: inlineText !== undefined,
        hasVoice: explicitVoice !== undefined,
        autoVoice: explicitVoice === undefined && voice !== undefined,
        hasOut: typeof opts.out === "string",
        outputFormat: opts.format ?? "auto",
        ssml: opts.ssml,
        noExpandAbbrev: opts.noExpandAbbrev,
      },
      (session) => synthesizeAndEmit(opts, Boolean(args.verbose), session),
    );

    if (outcome.exitCode !== undefined) process.exit(outcome.exitCode);
  },
});
