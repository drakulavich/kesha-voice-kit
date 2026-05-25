import { defineCommand } from "citty";
import { detectTextLanguageEngine, getEngineBinPath } from "../engine";
import { log } from "../log";
import { say, SayError, type SayFormat } from "../synth";
import { artifactFromBytes, artifactFromFile, createStatsRecorder } from "../stats";
import { pickVoiceForLang } from "../voice-routing";
import { createDiagnosticLogSession } from "../diagnostic-log";
import { diagnosticCharBucket, diagnosticSizeBucket } from "../diagnostic-events";

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

export function shouldRejectMissingSayText(
  inlineText: string | undefined,
  stdinIsTty: boolean | undefined,
): boolean {
  return (inlineText === undefined || inlineText.length === 0) && stdinIsTty === true;
}

function parseFiniteNumberFlag(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  const raw = String(value).trim();
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed)) {
    log.error(`${name} must be a finite number.`);
    process.exit(2);
  }
  return parsed;
}

function parseRateFlag(value: unknown): number | undefined {
  const rate = parseFiniteNumberFlag("--rate", value);
  if (rate === undefined) return undefined;
  if (rate < 0.5 || rate > 2.0) {
    log.error("--rate must be between 0.5 and 2.0.");
    process.exit(2);
  }
  return rate;
}

function parseBitrateFlag(value: unknown): number | undefined {
  const bitrate = parseFiniteNumberFlag("--bitrate", value);
  if (bitrate === undefined) return undefined;
  if (!Number.isInteger(bitrate) || bitrate <= 0) {
    log.error("--bitrate must be a positive integer.");
    process.exit(2);
  }
  return bitrate;
}

function parseSampleRateFlag(value: unknown): number | undefined {
  const sampleRate = parseFiniteNumberFlag("--sample-rate", value);
  if (sampleRate === undefined) return undefined;
  const supported = [8000, 12000, 16000, 24000, 48000];
  if (!Number.isInteger(sampleRate) || !supported.includes(sampleRate)) {
    log.error("--sample-rate must be one of 8000, 12000, 16000, 24000, 48000.");
    process.exit(2);
  }
  return sampleRate;
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
    lang: { type: "string", description: "BCP 47 language code (default en-us)" },
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
        "Disable Russian acronym auto-expansion (ВОЗ → 'вэ о зэ') for ru-vosk-* voices. " +
        "<say-as interpret-as='characters'> still works. Applies to Russian (ru-vosk-*) and English (en-*) voices.",
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

    // Validate --format up front so we surface a clear error before spawning
    // the engine subprocess. The engine repeats the check authoritatively, but
    // catching it here gives the user a faster failure mode in scripts.
    const fmtArg = typeof args.format === "string" ? args.format.toLowerCase() : undefined;
    let format: SayFormat | undefined;
    if (fmtArg) {
      if (fmtArg === "wav" || fmtArg === "ogg-opus" || fmtArg === "flac") {
        format = fmtArg;
      } else if (fmtArg === "opus" || fmtArg === "ogg") {
        format = "ogg-opus";
      } else {
        log.error(`unknown --format '${args.format}'. supported: wav, ogg-opus, flac`);
        process.exit(2);
      }
    }

    const rate = parseRateFlag(args.rate);
    const bitrate = parseBitrateFlag(args.bitrate);
    const sampleRate = parseSampleRateFlag(args["sample-rate"]);

    // Reject --bitrate / --sample-rate with WAV up front to surface the error fast.
    const hasOpusOnlyFlag = bitrate !== undefined || sampleRate !== undefined;
    if (hasOpusOnlyFlag) {
      const outExt = typeof args.out === "string"
        ? args.out.split(".").pop()?.toLowerCase()
        : undefined;
      const impliesOpus = outExt && ["ogg", "opus", "oga"].includes(outExt);
      // --bitrate / --sample-rate are Opus-only. Reject for wav and flac
      // (both lossless / no encoder knobs) and for any non-Opus extension.
      const resolvesToOpus = format === "ogg-opus" || (format === undefined && impliesOpus);
      if (!resolvesToOpus) {
        log.error("--bitrate and --sample-rate are only valid with --format ogg-opus");
        process.exit(2);
      }
    }

    const inlineText = typeof args.text === "string" ? args.text : undefined;
    const stdinIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    if (shouldRejectMissingSayText(inlineText, stdinIsTty)) {
      log.error("kesha say requires text or piped stdin. Usage: kesha say <text>");
      process.exit(2);
    }
    const text = await resolveText(inlineText);
    const explicitVoice = typeof args.voice === "string" ? args.voice : undefined;
    const voice = explicitVoice ?? (await autoRouteVoice(text));

    const opts = {
      text,
      voice,
      lang: typeof args.lang === "string" ? args.lang : undefined,
      out: typeof args.out === "string" ? args.out : undefined,
      rate,
      ssml: Boolean(args.ssml),
      format,
      bitrate,
      sampleRate,
      noExpandAbbrev: Boolean(args["no-expand-abbrev"]),
    };
    const stats = createStatsRecorder("say");
    const diagnosticLog = createDiagnosticLogSession();
    diagnosticLog.event("command.start", {
      command: "say",
      charBucket: diagnosticCharBucket(Array.from(text).length),
      hasInlineInput: inlineText !== undefined,
      hasVoice: explicitVoice !== undefined,
      autoVoice: explicitVoice === undefined && voice !== undefined,
      hasOut: typeof opts.out === "string",
      outputFormat: opts.format ?? "auto",
      ssml: opts.ssml,
      noExpandAbbrev: opts.noExpandAbbrev,
    });

    try {
      const startedAt = performance.now();
      if (opts.out) {
        const voiceLabel = opts.voice ?? "default voice";
        console.error(`Synthesizing ${voiceLabel} -> ${opts.out}...`);
      }
      const audio = await stats.timeStage("tts", () => say(opts));
      const ttsTimeMs = Math.round(performance.now() - startedAt);
      if (opts.out) {
        console.error(`Saved ${opts.out} (${ttsTimeMs}ms)`);
      }
      if (args.verbose && !opts.out) {
        // stderr — stdout may carry raw audio bytes when --out is omitted.
        console.error(`TTS time: ${ttsTimeMs}ms`);
      }
      let outputFormat: string = opts.format ?? "wav";
      let outputSizeBytes: number | null | undefined = audio.byteLength;
      if (opts.out) {
        const outputArtifact = artifactFromFile(opts.out, "output_audio");
        if (outputArtifact) stats.recordArtifact(outputArtifact);
        outputFormat = outputArtifact?.format || opts.format || "auto";
        outputSizeBytes = outputArtifact?.sizeBytes;
      } else {
        stats.recordArtifact(artifactFromBytes(audio.byteLength, "output_audio", opts.format ?? "wav"));
      }
      diagnosticLog.event("command.finish", {
        command: "say",
        status: "success",
        durationMs: ttsTimeMs,
        hasOut: Boolean(opts.out),
        outputFormat,
        outputSizeBucket: diagnosticSizeBucket(outputSizeBytes),
      });
      if (!opts.out) {
        process.stdout.write(audio);
      }
      stats.finish("success", 1);
      diagnosticLog.finish("success");
    } catch (err) {
      stats.recordError("tts", err);
      stats.finish("failed", 1);
      diagnosticLog.event("command.finish", {
        command: "say",
        status: "failed",
        errorKind: err instanceof SayError ? "say_error" : "error",
        exitCode: err instanceof SayError ? err.exitCode : 4,
      });
      diagnosticLog.finish("failed");
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
