import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import {
  isEngineInstalled,
  preflightRecordLive,
  recordEngine,
  type LiveAutoStopOptions,
  type RecordTarget,
} from "../engine";
import { installHint } from "../install-hint";
import { log } from "../log";

export interface RecordArgs {
  out?: string;
  live?: boolean;
  "max-seconds"?: string | number;
  "auto-stop"?: boolean;
  "auto-stop-silence-ms"?: string | number;
  "auto-stop-threshold"?: string | number;
  "auto-stop-min-speech-ms"?: string | number;
  debug?: boolean;
}

export type ResolvedRecordArgs =
  | { ok: true; target: RecordTarget; maxSeconds: number }
  | { ok: false; error: string };

const DEFAULT_MAX_SECONDS = 120;
const MAX_RECORD_SECONDS = 3600;
const DEFAULT_AUTO_STOP_SILENCE_MS = 1000;
const DEFAULT_AUTO_STOP_THRESHOLD = 0.5;
const DEFAULT_AUTO_STOP_MIN_SPEECH_MS = 250;

type Rejected = { ok: false; error: string };

function resolveTarget(args: RecordArgs): { ok: true; target: RecordTarget } | Rejected {
  const out = typeof args.out === "string" ? args.out.trim() : "";
  const live = args.live === true;
  if (live && out) {
    return {
      ok: false,
      error: "kesha record cannot combine --live with --out; --live prints the transcript to stdout.",
    };
  }
  if (!live && !out) {
    return { ok: false, error: "kesha record requires --out <path> (or --live)." };
  }
  return { ok: true, target: live ? { live: true } : { out } };
}

function resolveMaxSeconds(
  rawMax: string | number | undefined,
): { ok: true; maxSeconds: number } | Rejected {
  const raw = String(rawMax ?? DEFAULT_MAX_SECONDS).trim();
  const maxSeconds = Number(raw);
  if (raw === "" || !Number.isFinite(maxSeconds)) {
    return { ok: false, error: "--max-seconds must be a finite number." };
  }
  if (!Number.isInteger(maxSeconds) || maxSeconds <= 0 || maxSeconds > MAX_RECORD_SECONDS) {
    return {
      ok: false,
      error: `--max-seconds must be an integer between 1 and ${MAX_RECORD_SECONDS}.`,
    };
  }
  return { ok: true, maxSeconds };
}

export function resolveRecordArgs(args: RecordArgs): ResolvedRecordArgs {
  const target = resolveTarget(args);
  if (!target.ok) return target;
  const max = resolveMaxSeconds(args["max-seconds"]);
  if (!max.ok) return max;
  const autoStop = resolveAutoStop(args, target.target);
  if (!autoStop.ok) return autoStop;
  return {
    ok: true,
    target: autoStop.options ? { live: true, autoStop: autoStop.options } : target.target,
    maxSeconds: max.maxSeconds,
  };
}

function resolveAutoStop(
  args: RecordArgs,
  target: RecordTarget,
): { ok: true; options?: LiveAutoStopOptions } | Rejected {
  const enabled = args["auto-stop"] === true;
  const hasSettings =
    args["auto-stop-silence-ms"] !== undefined ||
    args["auto-stop-threshold"] !== undefined ||
    args["auto-stop-min-speech-ms"] !== undefined;
  if (!enabled && hasSettings) {
    return { ok: false, error: "auto-stop settings require --auto-stop." };
  }
  if (enabled && !target.live) {
    return { ok: false, error: "--auto-stop requires --live." };
  }
  if (!enabled) return { ok: true };

  const silenceMs = resolvePositiveInteger(
    args["auto-stop-silence-ms"],
    DEFAULT_AUTO_STOP_SILENCE_MS,
    "--auto-stop-silence-ms",
  );
  if (!silenceMs.ok) return silenceMs;
  const minSpeechMs = resolvePositiveInteger(
    args["auto-stop-min-speech-ms"],
    DEFAULT_AUTO_STOP_MIN_SPEECH_MS,
    "--auto-stop-min-speech-ms",
  );
  if (!minSpeechMs.ok) return minSpeechMs;
  const threshold = resolveThreshold(args["auto-stop-threshold"]);
  if (!threshold.ok) return threshold;
  return { ok: true, options: { silenceMs: silenceMs.value, threshold: threshold.value, minSpeechMs: minSpeechMs.value } };
}

function resolvePositiveInteger(
  rawValue: string | number | undefined,
  defaultValue: number,
  flag: string,
): { ok: true; value: number } | Rejected {
  const raw = String(rawValue ?? defaultValue).trim();
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: `${flag} must be a positive integer.` };
  }
  return { ok: true, value };
}

function resolveThreshold(
  rawValue: string | number | undefined,
): { ok: true; value: number } | Rejected {
  const raw = String(rawValue ?? DEFAULT_AUTO_STOP_THRESHOLD).trim();
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    return { ok: false, error: "--auto-stop-threshold must be greater than 0 and at most 1." };
  }
  return { ok: true, value };
}

/** Mirrors `src/transcribe.ts`'s "no transcription backend" guard message, worded for recording. */
export function noRecordingBackendMessage(): string {
  return (
    "Error: No recording backend is installed.\n\n" +
    "Run the following to get started:\n\n" +
    "    bun add -g @drakulavich/kesha-voice-kit\n" +
    `    ${installHint()}`
  );
}

export const recordCommand = defineCommand({
  meta: {
    name: "record",
    description: "Record microphone audio to a WAV file, or transcribe it live",
  },
  args: {
    out: {
      type: "string",
      description: "Write recorded WAV audio to this path",
    },
    live: {
      type: "boolean",
      description:
        "Transcribe the microphone live and print the transcript to stdout (CoreML on Apple Silicon only)",
      default: false,
    },
    "max-seconds": {
      type: "string",
      description: "Maximum recording duration in seconds",
      default: String(DEFAULT_MAX_SECONDS),
    },
    "auto-stop": {
      type: "boolean",
      description: "End a live recording after trailing silence (requires `kesha install --vad`)",
      default: false,
    },
    "auto-stop-silence-ms": {
      type: "string",
      description: "Trailing silence before auto-stop (default: 1000)",
    },
    "auto-stop-threshold": {
      type: "string",
      description: "Silero speech threshold for auto-stop (default: 0.5)",
    },
    "auto-stop-min-speech-ms": {
      type: "string",
      description: "Minimum speech before auto-stop may end a recording (default: 250)",
    },
    debug: {
      type: "boolean",
      description: "Trace engine subprocess calls on stderr (or KESHA_DEBUG=1)",
      default: false,
    },
  },
  async run({ args }) {
    if (args.debug) log.debugEnabled = true;
    const resolved = resolveRecordArgs(args as RecordArgs);
    if (!resolved.ok) {
      log.error(resolved.error);
      process.exit(2);
    }
    if (!isEngineInstalled()) {
      log.error(noRecordingBackendMessage());
      process.exit(1);
    }
    try {
      if (resolved.target.live) await preflightRecordLive(resolved.target.autoStop !== undefined);
      await recordEngine(resolved.target, resolved.maxSeconds);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
});
