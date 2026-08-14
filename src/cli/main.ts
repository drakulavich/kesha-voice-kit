import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import { existsSync, statSync } from "fs";
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
import { artifactFromFile, type StatsRecorder } from "../stats";
import { createPercentProgress } from "../progress";
import { getPendingSignalExitCode, waitForPendingSignalCleanup } from "../process-tree";
import type { TranscriptionSegment } from "../types";
import { diagnosticSizeBucket } from "../diagnostic-events";
import { runCommandSession, type CommandSession } from "./command-session";
import { USAGE_MESSAGE } from "./dispatch";
import type { CliContext } from "./context";
import { ENGINE_CODES, extractEngineErrorCode, TS_NATIVE_CODES } from "../error-codes";

interface MainCommandArgs {
  _: string[];
  json: boolean;
  toon: boolean;
  verbose: boolean;
  debug: boolean;
  vad: boolean;
  timestamps: boolean;
  speakers: boolean;
  itn: boolean;
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

/** True when `path` exists and is a directory. Used to reject directory positionals before any progress/engine spawn. */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pulled out of the citty `run` handler so the contract is unit-testable.
 * Mutex check happens AFTER format validation so unknown `--format` surfaces
 * with its own clearer error first.
 */
export type ResolvedOutputFormat =
  | { ok: true; format: "json" | "toon" | "transcript" | "text" }
  | { ok: false; error: string };

const SUPPORTED_FORMATS = ["transcript", "json", "toon"] as const;

function isSupportedFormat(format: string): format is (typeof SUPPORTED_FORMATS)[number] {
  return SUPPORTED_FORMATS.some((supported) => supported === format);
}

export function resolveOutputFormat(input: {
  json?: boolean;
  toon?: boolean;
  format?: string;
}): ResolvedOutputFormat {
  if (input.format !== undefined && !isSupportedFormat(input.format)) {
    return {
      ok: false,
      error: `unknown --format '${input.format}'. supported: ${SUPPORTED_FORMATS.join(", ")}`,
    };
  }
  if (
    (input.json && input.toon) ||
    (input.json && input.format === "toon") ||
    (input.toon && input.format === "json")
  ) {
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
  if (input.format === "transcript" && (input.json || input.toon)) {
    return {
      ok: false,
      error:
        "--format transcript is mutually exclusive with --json / --toon " +
        "(pick one output format).",
    };
  }
  return { ok: true, format: input.json ? "json" : input.toon ? "toon" : (input.format ?? "text") };
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

type NormalizedMainCommandArgs = MainCommandArgs & { noVad: boolean };

function normalizeMainCommandArgs(args: MainCommandArgs, rawArgs: string[]): NormalizedMainCommandArgs {
  return {
    ...args,
    vad: rawArgs.includes("--vad") || args.vad,
    noVad: rawArgs.includes("--no-vad"),
  };
}

export type TranscribeArgsValidation =
  | ({ ok: true } & ValidatedTranscribeArgs)
  | { ok: false; error: string };

/** Validates cross-flag consistency that citty can't express. */
export function validateTranscribeArgs(
  args: NormalizedMainCommandArgs,
  fmt: ResolvedOutputFormat & { ok: true },
): TranscribeArgsValidation {
  const { vad, noVad } = args;

  if (vad && noVad) {
    return { ok: false, error: "--vad and --no-vad are mutually exclusive." };
  }
  if (args.timestamps && fmt.format !== "json" && fmt.format !== "toon") {
    return { ok: false, error: "--timestamps requires --json, --toon, or --format {json,toon}." };
  }
  if (args.speakers && fmt.format !== "json" && fmt.format !== "toon") {
    return { ok: false, error: "--speakers requires --json, --toon, or --format {json,toon}." };
  }
  // #768: diarization labels VAD-windowed segments, so --no-vad leaves nothing to label.
  if (args.speakers && noVad) {
    return {
      ok: false,
      error:
        "--speakers cannot be combined with --no-vad: speaker labels attach to VAD-windowed " +
        "speech segments, and --no-vad leaves the whole file as one segment. Drop --no-vad " +
        "(VAD engages automatically for --speakers), or drop --speakers.",
    };
  }
  if (args["include-errors"] && fmt.format !== "json" && fmt.format !== "toon") {
    return { ok: false, error: "--include-errors requires --json, --toon, or --format {json,toon}." };
  }

  const vadMode: ValidatedTranscribeArgs["vadMode"] = vad ? "on" : noVad ? "off" : "auto";
  return { ok: true, vadMode, outputFormat: fmt.format };
}

async function detectLanguages(
  file: string,
  text: string,
  options: {
    wantsLangId: boolean;
    expectedLang?: string;
    progress: ReturnType<typeof createPercentProgress> | null;
    stats: StatsRecorder;
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
  itn: boolean;
  wantsLangId: boolean;
  expectedLang?: string;
  reportProgress: boolean;
};

type ProcessFileSuccess = { ok: true; result: TranscribeResult };
type ProcessFileFailure = { ok: false; error: TranscribeErrorRecord };

async function processFile(
  file: string,
  options: ProcessFileOptions,
  recorders: CommandSession,
): Promise<ProcessFileSuccess | ProcessFileFailure> {
  const { vadMode, timestamps, speakers, itn, wantsLangId, expectedLang, reportProgress } = options;
  const { stats, diagnosticLog } = recorders;

  if (!existsSync(file)) {
    stats.recordError("input", new Error("File not found"), TS_NATIVE_CODES.INPUT_NOT_FOUND);
    diagnosticLog.event("input.missing", {
      command: "transcribe",
      error_code: TS_NATIVE_CODES.INPUT_NOT_FOUND,
    });
    log.error(`${file}: error [${TS_NATIVE_CODES.INPUT_NOT_FOUND}]: File not found`);
    return { ok: false, error: { file, code: TS_NATIVE_CODES.INPUT_NOT_FOUND, message: "File not found" } };
  }

  if (isDirectoryPath(file)) {
    stats.recordError("input", new Error("is a directory"), TS_NATIVE_CODES.INVALID_ARG);
    diagnosticLog.event("input.invalid", {
      command: "transcribe",
      error_code: TS_NATIVE_CODES.INVALID_ARG,
    });
    log.error(`${file}: error [${TS_NATIVE_CODES.INVALID_ARG}]: is a directory (expected an audio file)`);
    return {
      ok: false,
      error: { file, code: TS_NATIVE_CODES.INVALID_ARG, message: "is a directory (expected an audio file)" },
    };
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
    await preflightTranscribeWithSegments({ vad: vadMode, timestamps, speakers, itn });
    progress = reportProgress
      ? createPercentProgress(`Transcribing ${file}`, {
          estimatedTotalMs: speakers ? 60 * 60 * 1000 : 30 * 60 * 1000,
        })
      : null;
    const transcript = await stats.timeStage("transcribe", () =>
      transcribeWithSegments(file, { vad: vadMode, timestamps, speakers, itn }),
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

/** `verbose` is only consulted for the plain-text fallback path. */
function writeOutput(
  results: TranscribeResult[],
  errors: TranscribeErrorRecord[],
  format: ValidatedTranscribeArgs["outputFormat"],
  opts: { includeErrors: boolean; verbose: boolean },
): void {
  const errorEnvelope = (format === "json" || format === "toon") && opts.includeErrors;
  // #773: `[]` reads as "ran fine, nothing found" to a consumer ignoring the exit code.
  if (results.length === 0 && errors.length > 0 && !errorEnvelope) return;

  if (format === "json") {
    process.stdout.write(formatJsonOutput(results, opts.includeErrors ? errors : undefined));
  } else if (format === "toon") {
    process.stdout.write(formatToonOutput(results, opts.includeErrors ? errors : undefined));
  } else if (format === "transcript") {
    process.stdout.write(formatTranscriptOutput(results));
  } else if (opts.verbose) {
    process.stdout.write(formatVerboseOutput(results));
  } else {
    process.stdout.write(formatTextOutput(results));
  }
}

/** The transcribe command, bound to the global flags dispatch resolved before citty. */
export function createMainCommand(context: CliContext = { quiet: false, disableColor: false }) {
  return defineCommand({
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
        "  mcp        Run an MCP server over stdio.\n" +
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
        description: "Include speaker labels in segments. Needs --json/--toon and darwin-arm64; run `kesha install --diarize` first (it installs VAD too). Implies --timestamps, and engages VAD windowing at any duration (so it cannot be combined with --no-vad).",
        default: false,
      },
      itn: {
        type: "boolean",
        description: "Rewrite spoken-form numbers, money, dates and times to written form (\"two hundred thirty two\" -> \"232\"). English-only; other languages pass through unchanged.",
        default: false,
      },
      "include-errors": {
        type: "boolean",
        description: "With --json or --toon, output { results, errors } so scripts can read per-file failures without parsing stderr",
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
        description: "Force full-file ASR for short/medium files; long audio fails early. Incompatible with --speakers",
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
      const files = args._;

      const fmt = resolveOutputFormat({
        json: args.json,
        toon: args.toon,
        format: args.format,
      });
      if (!fmt.ok) {
        log.error(fmt.error);
        process.exit(2);
      }

      const validated = validateTranscribeArgs(normalizeMainCommandArgs(args, rawArgs), fmt);
      if (!validated.ok) {
        log.error(validated.error);
        process.exit(2);
      }
      const { vadMode, outputFormat } = validated;

      if (files.length === 0) {
        log.info(USAGE_MESSAGE);
        process.exit(1);
      }

      const wantsLangId = !!(args.lang || args.verbose || outputFormat !== "text");
      const reportProgress = shouldReportTranscribeProgress({
        stderrIsTty: process.stderr.isTTY === true,
        stdoutIsTty: process.stdout.isTTY === true,
        debugEnabled: log.isDebugEnabled(),
        quiet: context.quiet,
      });

      const { status } = await runCommandSession(
        "transcribe",
        {
          itemCount: files.length,
          outputFormat,
          vadMode,
          timestamps: args.timestamps,
          speakers: args.speakers,
          itn: args.itn,
          includeErrors: args["include-errors"],
          hasExpectedLang: Boolean(args.lang),
        },
        async (session) => {
          const results: TranscribeResult[] = [];
          const errors: TranscribeErrorRecord[] = [];

          for (const file of files) {
            const outcome = await processFile(
              file,
              {
                vadMode,
                timestamps: args.timestamps,
                speakers: args.speakers,
                itn: args.itn,
                wantsLangId,
                expectedLang: args.lang,
                reportProgress,
              },
              session,
            );
            if (outcome.ok) {
              results.push(outcome.result);
            } else {
              errors.push(outcome.error);
            }
          }

          writeOutput(results, errors, outputFormat, {
            includeErrors: args["include-errors"],
            verbose: args.verbose,
          });

          return {
            status: errors.length > 0 ? "failed" : "success",
            itemCount: files.length,
            finishFields: {
              itemCount: files.length,
              resultCount: results.length,
              errorCount: errors.length,
            },
          };
        },
      );

      if (status === "failed") {
        const signalExitCode = getPendingSignalExitCode();
        if (signalExitCode !== null) {
          await waitForPendingSignalCleanup();
          process.exit(signalExitCode);
        }
        process.exit(1);
      }
    },
  });
}

/** Package-root export kept for consumers importing `mainCommand`; the default-context binding. */
export const mainCommand = createMainCommand();
