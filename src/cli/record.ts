import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import { isEngineInstalled, preflightRecordLive, recordEngine, type RecordTarget } from "../engine";
import { installHint } from "../install-hint";
import { log } from "../log";

export interface RecordArgs {
  out?: string;
  live?: boolean;
  "max-seconds"?: string | number;
  debug?: boolean;
}

export type ResolvedRecordArgs =
  | { ok: true; target: RecordTarget; maxSeconds: number }
  | { ok: false; error: string };

const DEFAULT_MAX_SECONDS = 120;
const MAX_RECORD_SECONDS = 3600;

export function resolveRecordArgs(args: RecordArgs): ResolvedRecordArgs {
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

  const rawMax = args["max-seconds"] ?? String(DEFAULT_MAX_SECONDS);
  const raw = String(rawMax).trim();
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

  return { ok: true, target: live ? { live: true } : { out }, maxSeconds };
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
      if (resolved.target.live) await preflightRecordLive();
      await recordEngine(resolved.target, resolved.maxSeconds);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
});
