import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import { isEngineInstalled, recordEngine } from "../engine";
import { installHint } from "../install-hint";
import { log } from "../log";

export interface RecordArgs {
  out?: string;
  "max-seconds"?: string | number;
  debug?: boolean;
}

export type ResolvedRecordArgs =
  | { ok: true; out: string; maxSeconds: number }
  | { ok: false; error: string };

const DEFAULT_MAX_SECONDS = 120;
const MAX_RECORD_SECONDS = 3600;

export function resolveRecordArgs(args: RecordArgs): ResolvedRecordArgs {
  const out = typeof args.out === "string" ? args.out.trim() : "";
  if (!out) {
    return { ok: false, error: "kesha record requires --out <path>." };
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

  return { ok: true, out, maxSeconds };
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
    description: "Record microphone audio to a WAV file",
  },
  args: {
    out: {
      type: "string",
      description: "Write recorded WAV audio to this path",
      required: true,
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
      await recordEngine(resolved.out, resolved.maxSeconds);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
});
