import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import { existsSync } from "fs";
import { detect } from "tinyld";
import { preflightTranscribeWithSegments, transcribeWithSegments } from "../transcribe";
import { detectAudioLanguageEngine, detectTextLanguageEngine } from "../engine";
import type { LangDetectResult } from "../engine";
import { log } from "../log";
import type { TranscribeErrorRecord, TranscribeResult } from "../types";
import {
  formatJsonOutput,
  formatTextOutput,
  formatTranscriptOutput,
  formatVerboseOutput,
} from "../format";
import { packageVersion } from "../package-info";
import { formatToonOutput } from "../toon";
import { artifactFromFile, createStatsRecorder } from "../stats";
import { createPercentProgress } from "../progress";
import { getPendingSignalExitCode, waitForPendingSignalCleanup } from "../process-tree";
import type { TranscriptionSegment } from "../types";
import { createDiagnosticLogSession } from "../diagnostic-log";
import { diagnosticSizeBucket } from "../diagnostic-events";
import { ENGINE_CODES, extractEngineErrorCode, TS_NATIVE_CODES } from "../error-codes";

interface MainCommandArgs {
  _: string[];
  json: boolean;
  toon: boolean;
  verbose: boolean;
  debug: boolean;
  vad: boolean;
  "no-vad": boolean;
  noVad?: boolean;
  no_vad?: boolean;
  timestamps: boolean;
  speakers: boolean;
  "include-errors": boolean;
  format?: string;
  lang?: string;
  quiet: boolean;
  "no-color": boolean;
}

export function detectLanguage(text: string): string {
  if (!text) return "";
  return detect(text);
}

/**
 * Pure validation + normalization of the output-format selection. Pulled
 * out of the citty `run` handler so the contract is unit-testable without
 * spawning the CLI binary; the handler just owns the side-effect arms
 * (log.error + process.exit) when this returns `{ ok: false }`.
 *
 * Inputs accept the three knobs the user can flip:
 * - `--json` (boolean) — long-form alias for `--format json`
 * - `--toon` (boolean) — long-form alias for `--format toon`
 * - `--format <value>` — must be one of `transcript`, `json`, `toon`
 *
 * Mutex: `--json` and `--toon` cannot both be requested. Either via the
 * booleans or `--format` cross-pollination (`--json --format toon` →
 * error). The mutex check happens AFTER format validation, so unknown
 * `--format` still surfaces with its own clearer error first.
 */
export type ResolvedOutputFormat =
  | {
      ok: true;
      wantsJson: boolean;
      wantsToon: boolean;
      wantsTranscript: boolean;
    }
  | { ok: false; error: string };

const SUPPORTED_FORMATS = ["transcript", "json", "toon"] as const;

export function resolveOutputFormat(input: {
  json?: boolean;
  toon?: boolean;
  format?: string;
}): ResolvedOutputFormat {
  if (input.format !== undefined && !SUPPORTED_FORMATS.includes(input.format as never)) {
    return {
      ok: false,
      error: `unknown --format '${input.format}'. supported: ${SUPPORTED_FORMATS.join(", ")}`,
    };
  }
  const wantsJson = !!input.json || input.format === "json";
  const wantsToon = !!input.toon || input.format === "toon";
  const wantsTranscript = input.format === "transcript";
  if (wantsJson && wantsToon) {
    return {
      ok: false,
      error: "--json and --toon are mutually exclusive (pick one output format).",
    };
  }
  // `--format transcript` + boolean `--json` / `--toon` was previously
  // accepted and silently produced the boolean's format (because the
  // dispatch checked wantsJson/wantsToon first). Greptile P2 on #300
  // flagged the silent override. Fail loudly with the same shape as
  // the json/toon mutex — symmetric across all three formats.
  if (wantsTranscript && (wantsJson || wantsToon)) {
    return {
      ok: false,
      error:
        "--format transcript is mutually exclusive with --json / --toon " +
        "(pick one output format).",
    };
  }
  return { ok: true, wantsJson, wantsToon, wantsTranscript };
}

export function checkLanguageMismatch(expected: string | undefined, detected: string): string | null {
  if (!expected || !detected || expected === detected) return null;
  return `warning: expected language "${expected}" but detected "${detected}"`;
}

export function shouldReportTranscribeProgress(input: {
  stderrIsTty: boolean;
  stdoutIsTty: boolean;
  debugEnabled: boolean;
  quiet?: boolean;
}): boolean {
  if (input.quiet) return false;
  if (input.debugEnabled) return false;
  return input.stderrIsTty || !input.stdoutIsTty;
}

const AUDIO_LANG_ID_LONG_AUDIO_THRESHOLD_SECONDS = 10 * 60;

export function estimateTranscriptDurationSeconds(segments: TranscriptionSegment[]): number | null {
  const duration = segments.reduce((max, segment) => {
    const end = Number(segment.end);
    return Number.isFinite(end) && end > max ? end : max;
  }, 0);
  return duration > 0 ? duration : null;
}

export function shouldRunAudioLanguageDetection(input: {
  wantsLangId: boolean;
  transcriptDurationSeconds: number | null;
}): boolean {
  if (!input.wantsLangId) return false;
  if (input.transcriptDurationSeconds === null) return true;
  return input.transcriptDurationSeconds <= AUDIO_LANG_ID_LONG_AUDIO_THRESHOLD_SECONDS;
}

export type ValidatedTranscribeArgs = {
  vadMode: "on" | "off" | "auto";
  outputFormat: "json" | "toon" | "transcript" | "text";
};

/**
 * Validates the transcribe-specific flags that require cross-flag consistency
 * checks beyond what citty can express. Calls `log.error` + `process.exit(2)`
 * on any violation — matching the original inline behavior byte-for-byte.
 *
 * Owns:
 * - --vad / --no-vad mutex (requires rawArgs to detect the explicit --no-vad)
 * - --timestamps / --speakers guards (require machine-readable output)
 * - --include-errors guard (requires --json)
 * - derivation of `vadMode` and `outputFormat`
 */
export function validateTranscribeArgs(
  args: MainCommandArgs,
  rawArgs: string[],
  fmt: ResolvedOutputFormat & { ok: true },
): ValidatedTranscribeArgs {
  const { wantsJson, wantsToon, wantsTranscript } = fmt;

  // citty treats --no-vad as the negated form of --vad, so read rawArgs
  // to distinguish "off" from the default auto mode and to catch both flags.
  const vad = rawArgs.includes("--vad") || Boolean(args.vad);
  const noVad = rawArgs.includes("--no-vad") || Boolean(args["no-vad"] ?? args.noVad ?? args.no_vad);

  if (vad && noVad) {
    log.error("--vad and --no-vad are mutually exclusive.");
    process.exit(2);
  }
  if (args.timestamps && !(wantsJson || wantsToon)) {
    log.error("--timestamps requires --json, --toon, or --format {json,toon}.");
    process.exit(2);
  }
  if (args.speakers && !(wantsJson || wantsToon)) {
    log.error("--speakers requires --json, --toon, or --format {json,toon}.");
    process.exit(2);
  }
  if (args["include-errors"] && !wantsJson) {
    log.error("--include-errors requires --json or --format json.");
    process.exit(2);
  }

  const vadMode: ValidatedTranscribeArgs["vadMode"] = vad ? "on" : noVad ? "off" : "auto";
  const outputFormat: ValidatedTranscribeArgs["outputFormat"] = wantsJson
    ? "json"
    : wantsToon
      ? "toon"
      : wantsTranscript
        ? "transcript"
        : "text";

  return { vadMode, outputFormat };
}

/**
 * Runs audio + text language detection for a single transcript, applying the
 * long-audio skip guard and both checkLanguageMismatch calls.
 *
 * Returns `{ audioLanguage, textLanguage, lang }` — the caller owns building
 * the final `TranscribeResult`.
 */
async function detectLanguages(
  file: string,
  text: string,
  options: {
    wantsLangId: boolean;
    expectedLang?: string;
    progress: ReturnType<typeof createPercentProgress> | null;
    stats: ReturnType<typeof createStatsRecorder>;
    transcriptDurationSeconds: number | null;
  },
): Promise<{
  audioLanguage: LangDetectResult | undefined;
  textLanguage: LangDetectResult | undefined;
  lang: string;
  ranAudioLangId: boolean;
}> {
  const { wantsLangId, expectedLang, progress, stats, transcriptDurationSeconds } = options;

  let audioResult: LangDetectResult | null = null;
  if (shouldRunAudioLanguageDetection({ wantsLangId, transcriptDurationSeconds })) {
    audioResult = await stats.timeStage("lang_id_audio", () => detectAudioLanguageEngine(file));
  } else if (wantsLangId) {
    log.debug(
      `skip lang_id_audio for ${file}: transcript duration ${transcriptDurationSeconds?.toFixed(1)}s exceeds ` +
        `${AUDIO_LANG_ID_LONG_AUDIO_THRESHOLD_SECONDS}s`,
    );
  }

  let audioLanguage: LangDetectResult | undefined;
  if (audioResult && audioResult.code) {
    audioLanguage = audioResult;
  }

  if (audioLanguage && expectedLang && audioLanguage.confidence > 0.8) {
    const mismatch = checkLanguageMismatch(expectedLang, audioLanguage.code);
    if (mismatch) {
      progress?.interrupt(() => log.warn(`${file}: ${mismatch} (from audio)`));
    }
  }

  const tinyldLang = wantsLangId ? detectLanguage(text) : "";
  let textLanguage: LangDetectResult | undefined;

  if (wantsLangId) {
    const engineTextResult = await stats.timeStage("lang_id_text", () => detectTextLanguageEngine(text));
    if (engineTextResult && engineTextResult.code) {
      textLanguage = engineTextResult;
    }
  }

  const lang = textLanguage?.code || tinyldLang;

  const mismatchWarning = checkLanguageMismatch(expectedLang, lang);
  if (mismatchWarning) {
    progress?.interrupt(() => log.warn(`${file}: ${mismatchWarning}`));
  }

  return {
    audioLanguage,
    textLanguage: textLanguage ?? (tinyldLang ? { code: tinyldLang, confidence: 0 } : undefined),
    lang,
    ranAudioLangId: audioResult !== null,
  };
}

type ProcessFileOptions = {
  vadMode: "on" | "off" | "auto";
  timestamps: boolean;
  speakers: boolean;
  wantsLangId: boolean;
  expectedLang?: string;
  reportProgress: boolean;
};

type ProcessFileRecorders = {
  stats: ReturnType<typeof createStatsRecorder>;
  diagnosticLog: ReturnType<typeof createDiagnosticLogSession>;
};

type ProcessFileSuccess = { ok: true; result: TranscribeResult };
type ProcessFileFailure = { ok: false; error: TranscribeErrorRecord };

/**
 * Processes a single audio file: existence check, engine call, lang detection,
 * diagnostic events. Returns a discriminated union so the caller can push to
 * the appropriate bucket without catching.
 */
async function processFile(
  file: string,
  options: ProcessFileOptions,
  recorders: ProcessFileRecorders,
): Promise<ProcessFileSuccess | ProcessFileFailure> {
  const { vadMode, timestamps, speakers, wantsLangId, expectedLang, reportProgress } = options;
  const { stats, diagnosticLog } = recorders;

  if (!existsSync(file)) {
    stats.recordError("input", new Error("File not found"), TS_NATIVE_CODES.INPUT_NOT_FOUND);
    diagnosticLog.event("input.missing", {
      command: "transcribe",
      error_code: TS_NATIVE_CODES.INPUT_NOT_FOUND,
    });
    log.error(`${file}: File not found`);
    return { ok: false, error: { file, code: TS_NATIVE_CODES.INPUT_NOT_FOUND, message: "File not found" } };
  }

  const inputArtifact = artifactFromFile(file, "input_audio");
  if (inputArtifact) {
    stats.recordArtifact(inputArtifact);
    diagnosticLog.event("input.audio", {
      command: "transcribe",
      format: inputArtifact.format || null,
      sizeBucket: diagnosticSizeBucket(inputArtifact.sizeBytes),
    });
  }

  const startedAt = performance.now();
  let progress: ReturnType<typeof createPercentProgress> | null = null;
  try {
    await preflightTranscribeWithSegments({ vad: vadMode, timestamps, speakers });
    progress = reportProgress
      ? createPercentProgress(`Transcribing ${file}`, {
          estimatedTotalMs: speakers ? 60 * 60 * 1000 : 30 * 60 * 1000,
        })
      : null;
    const transcript = await stats.timeStage("transcribe", () =>
      transcribeWithSegments(file, { vad: vadMode, timestamps, speakers }),
    );
    const { text, segments } = transcript;
    const transcriptDurationSeconds = estimateTranscriptDurationSeconds(segments);

    const { audioLanguage, textLanguage, lang, ranAudioLangId } = await detectLanguages(file, text, {
      wantsLangId,
      expectedLang,
      progress,
      stats,
      transcriptDurationSeconds,
    });

    const sttTimeMs = Math.round(performance.now() - startedAt);
    const result: TranscribeResult = {
      file,
      text,
      lang,
      audioLanguage,
      textLanguage,
      sttTimeMs,
    };
    if (timestamps || speakers) {
      result.segments = segments;
    }

    diagnosticLog.event("engine.exit", {
      command: "transcribe",
      status: "success",
      durationMs: sttTimeMs,
      segmentCount: segments.length,
      ranAudioLangId,
      ranTxtLangId: textLanguage !== undefined,
    });
    progress?.finish(`Transcribed ${file}`);
    return { ok: true, result };
  } catch (err: unknown) {
    progress?.stop();
    const stderrText = errorMessage(err);
    const code = extractEngineErrorCode(stderrText) ?? ENGINE_CODES.TRANSCRIBE_FAILED;
    stats.recordError("transcribe", err, code);
    diagnosticLog.event("engine.exit", {
      command: "transcribe",
      status: "failed",
      errorKind: "transcribe_failed",
      error_code: code,
    });
    log.error(`${file}: ${stderrText}`);
    return { ok: false, error: { file, code, message: stderrText } };
  }
}

/**
 * Writes the final output to stdout in the requested format.
 * The `verbose` flag is only consulted for the plain-text fallback path.
 */
function writeOutput(
  results: TranscribeResult[],
  errors: TranscribeErrorRecord[],
  format: ValidatedTranscribeArgs["outputFormat"],
  opts: { includeErrors: boolean; verbose: boolean },
): void {
  if (format === "json") {
    process.stdout.write(formatJsonOutput(results, opts.includeErrors ? errors : undefined));
  } else if (format === "toon") {
    process.stdout.write(formatToonOutput(results));
  } else if (format === "transcript") {
    process.stdout.write(formatTranscriptOutput(results));
  } else if (opts.verbose) {
    process.stdout.write(formatVerboseOutput(results));
  } else {
    process.stdout.write(formatTextOutput(results));
  }
}

export const mainCommand = defineCommand({
  meta: {
    name: "kesha",
    version: packageVersion,
    description:
      "Kesha Voice Kit — open-source voice toolkit for Apple Silicon.\n" +
      "\n" +
      "Examples:\n" +
      "  kesha audio.ogg          Transcribe an audio file.\n" +
      "  kesha --json audio.ogg   Transcribe with machine-readable output.\n" +
      "  kesha say \"hello\"        Speak text (text-to-speech).\n" +
      "  kesha init               Guided first-time setup.\n" +
      "\n" +
      "Commands:\n" +
      "  completions  Print shell completion script.\n" +
      "  doctor     Collect support diagnostics.\n" +
      "  init       Interactive setup guide for Kesha features.\n" +
      "  install    Download engine and models.\n" +
      "  logs       Manage local privacy-safe diagnostic logs.\n" +
      "  manpage    Print the kesha(1) manpage.\n" +
      "  record     Record microphone audio to a WAV file.\n" +
      "  status     Inspect installed backend.\n" +
      "  say        Synthesize speech from text.\n" +
      "  stats      Manage local anonymous performance stats.\n" +
      "  support-bundle  Create a redacted diagnostics archive.",
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
    timestamps: {
      type: "boolean",
      description: "Include timestamped transcript segments in JSON/TOON output",
      default: false,
    },
    speakers: {
      type: "boolean",
      description: "Include speaker labels in segments. Needs --json/--toon and darwin-arm64; run `kesha install --diarize` first. Implies --timestamps.",
      default: false,
    },
    "include-errors": {
      type: "boolean",
      description: "With --json, output { results, errors } so scripts can read per-file failures without parsing stderr",
      default: false,
    },
    verbose: {
      type: "boolean",
      description: "Show language detection details",
      default: false,
    },
    format: {
      type: "string",
      description: "Output format: transcript | json | toon (long-form alias for --json / --toon)",
    },
    lang: {
      type: "string",
      description: "Expected language code, e.g. en or en-us (see docs/languages.md); warn if mismatch",
    },
    debug: {
      type: "boolean",
      description: "Trace engine subprocess calls on stderr (or KESHA_DEBUG=1)",
      default: false,
    },
    vad: {
      type: "boolean",
      description: "Force Silero VAD preprocessing (kesha install --vad first). Without this, VAD auto-engages on audio ≥ 120s.",
      default: false,
    },
    "no-vad": {
      type: "boolean",
      description: "Force full-file ASR for short/medium files; long audio fails early",
      default: false,
    },
    // quiet and no-color are resolved before citty in dispatch.ts (so they
    // apply to every command, not just transcribe); declared here only so they
    // appear in `kesha --help`.
    quiet: {
      type: "boolean",
      alias: "q",
      description: "Suppress progress output; print only results and errors",
      default: false,
    },
    "no-color": {
      type: "boolean",
      description: "Disable ANSI colors (also via NO_COLOR=1; auto-off when CI=true)",
      default: false,
    },
  },
  async run({ args, rawArgs }: { args: MainCommandArgs; rawArgs: string[] }) {
    if (args.debug) log.debugEnabled = true;
    // `log.quietEnabled` is set globally in dispatch.ts (where --quiet/-q is
    // resolved and stripped before citty), so it already reflects --quiet here.
    const files = args._;

    // Validate `--format <value>` and normalize into the boolean flags
    // that the rest of this handler consults. Routing happens in
    // `resolveOutputFormat` so the contract is unit-testable without
    // spawning the CLI; the handler just owns the side-effect arms
    // (log.error + process.exit).
    const fmt = resolveOutputFormat({
      json: args.json,
      toon: args.toon,
      format: args.format,
    });
    if (!fmt.ok) {
      log.error(fmt.error);
      process.exit(2);
    }

    const { vadMode, outputFormat } = validateTranscribeArgs(args, rawArgs, fmt);

    if (files.length === 0) {
      log.info(
        "Usage: kesha <audio_file> [audio_file ...]\n" +
          "       kesha completions <bash|zsh|fish>\n" +
          "       kesha doctor [--json] [--redact]\n" +
          "       kesha install [--no-cache]\n" +
          "       kesha logs [enable|disable|mode|status|path|reset]\n" +
          "       kesha manpage\n" +
          "       kesha record --out path.wav [--max-seconds 120]\n" +
          "       kesha status\n" +
          "       kesha say <text>\n" +
          "       kesha stats [enable|disable|status|week|errors|export|reset|vacuum|retention]\n" +
          "       kesha support-bundle [--output path.tar.gz]",
      );
      process.exit(1);
    }

    let hasError = false;
    const results: TranscribeResult[] = [];
    const errors: TranscribeErrorRecord[] = [];
    const stats = createStatsRecorder("transcribe");
    const diagnosticLog = createDiagnosticLogSession();
    diagnosticLog.event("command.start", {
      command: "transcribe",
      itemCount: files.length,
      outputFormat,
      vadMode,
      timestamps: args.timestamps,
      speakers: args.speakers,
      includeErrors: args["include-errors"],
      hasExpectedLang: Boolean(args.lang),
    });

    const wantsLangId = !!(args.lang || args.verbose || outputFormat !== "text");
    const reportProgress = shouldReportTranscribeProgress({
      stderrIsTty: process.stderr.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      debugEnabled: log.isDebugEnabled(),
      quiet: log.quietEnabled,
    });

    for (const file of files) {
      const outcome = await processFile(
        file,
        {
          vadMode,
          timestamps: args.timestamps,
          speakers: args.speakers,
          wantsLangId,
          expectedLang: args.lang,
          reportProgress,
        },
        { stats, diagnosticLog },
      );
      if (outcome.ok) {
        results.push(outcome.result);
      } else {
        hasError = true;
        errors.push(outcome.error);
      }
    }

    writeOutput(results, errors, outputFormat, {
      includeErrors: args["include-errors"],
      verbose: args.verbose,
    });

    stats.finish(hasError ? "failed" : "success", files.length);
    diagnosticLog.event("command.finish", {
      command: "transcribe",
      status: hasError ? "failed" : "success",
      itemCount: files.length,
      resultCount: results.length,
      errorCount: errors.length,
    });
    diagnosticLog.finish(hasError ? "failed" : "success");

    if (hasError) {
      const signalExitCode = getPendingSignalExitCode();
      if (signalExitCode !== null) {
        await waitForPendingSignalCleanup();
        process.exit(signalExitCode);
      }
      process.exit(1);
    }
  },
});
