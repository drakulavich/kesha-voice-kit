import { getDescribe, getEngineBinPath, isEngineInstalled } from "./engine";
import { runEngineProcess } from "./engine/spawn";
import { validateArgv } from "./engine/describe";
import { engineFailure, exitCodeFor, KeshaError, type ErrorOrigin, type EventSinks } from "./engine/events";
import { installHint } from "./install-hint";
import { log } from "./log";
import { engineAbortError, interruptedRun } from "./process-tree";

/**
 * Wire format for the synthesized audio. Matches the engine's `--format` flag.
 * - `wav` (default): RIFF WAV at the engine's native sample rate.
 * - `ogg-opus`: OGG-encapsulated Opus, mono. The format Telegram, WhatsApp,
 *   Signal, and Discord render as native voice messages. See #223.
 * - `flac`: lossless, royalty-free, plays in every modern browser including
 *   Safari/iOS. Keeps the engine's native rate; no bitrate knob.
 */
export type SayFormat = "wav" | "ogg-opus" | "flac";
export const SUPPORTED_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000] as const;
export type SupportedSampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];
export const MAX_TEXT_CHARS = 5000;

type SayBase = {
  /**
   * Text to synthesize. Required for programmatic callers — `say()` does not
   * forward the host process's stdin. The CLI (`kesha say` with no positional
   * arg) handles stdin separately before invoking `say()`.
   */
  text?: string;
  voice?: string;
  lang?: string;
  out?: string;
  rate?: number;
  /** Parse `text` as SSML (`<speak>…<break time="500ms"/>…</speak>`). See issue #122. */
  ssml?: boolean;
  /** Disable acronym auto-expansion; dropped with a warning on an engine whose describe document does not advertise the expansion (#842). */
  noExpandAbbrev?: boolean;
  /** Cancels the synthesis: the engine subprocess is terminated and the call rejects with `E_INTERRUPTED`. */
  signal?: AbortSignal;
};

type OpusOpts = {
  format: "ogg-opus";
  bitrate?: number;
  sampleRate?: SupportedSampleRate;
};

type PcmOpts = {
  format?: "wav" | "flac";
  bitrate?: never;
  sampleRate?: never;
};

export type SayOptions = SayBase & (OpusOpts | PcmOpts);

/** Build the argv passed to `kesha-engine say`; `validateArgv` decides what the installed engine accepts. */
export function buildSayArgs(o: SayOptions): string[] {
  const args: string[] = ["say"];
  if (o.voice) args.push("--voice", o.voice);
  if (o.lang) args.push("--lang", o.lang);
  if (o.out) args.push("--out", o.out);
  if (o.rate !== undefined && o.rate !== 1.0) args.push("--rate", String(o.rate));
  if (o.ssml) args.push("--ssml");
  if (o.format) args.push("--format", o.format);
  if (o.bitrate !== undefined) args.push("--bitrate", String(o.bitrate));
  if (o.sampleRate !== undefined) args.push("--sample-rate", String(o.sampleRate));
  if (o.noExpandAbbrev) args.push("--no-expand-abbrev");
  if (o.text !== undefined && o.text.length > 0) args.push(o.text);
  return args;
}

export class SayError extends KeshaError {
  constructor(
    message: string,
    exitCode: number,
    stderr: string,
    code: string = "E_INTERNAL",
    hint?: string,
    origin: ErrorOrigin = "cli",
  ) {
    super(code, message, { exitCode, stderr, hint, origin });
    this.name = "SayError";
  }
}

/** Fault signals, by number. SIGBUS is 10 on darwin but 7 on linux. */
const FAULT_SIGNALS: Record<number, string> = { 4: "SIGILL", 6: "SIGABRT", 8: "SIGFPE", 11: "SIGSEGV" };

/** Explains a signal death, which leaves no error event; the wait status outranks Bun's signalCode (10 is SIGBUS on darwin, SIGUSR1 to Bun). */
export function engineCrashMessage(
  exitCode: number,
  signalCode: string | null,
  platform: string = process.platform,
): string | null {
  const number = exitCode > 128 ? exitCode - 128 : undefined;
  const sigbus = platform === "darwin" ? 10 : 7;
  const signal =
    number === undefined
      ? (signalCode ?? undefined)
      : number === sigbus
        ? "SIGBUS"
        : (FAULT_SIGNALS[number] ?? signalCode ?? undefined);
  if (!signal) return null;
  const base = `kesha-engine was killed by ${signal} and produced no audio`;
  // Every physical Apple Silicon Mac has a Neural Engine; virtualised macOS has
  // none, so CoreML runs Kokoro's stages through libBNNS on the CPU, where some
  // input shapes overflow the dispatch worker's stack (#742).
  if (platform === "darwin" && (signal === "SIGBUS" || signal === "SIGSEGV")) {
    return (
      `${base}. This is commonly a virtualised macOS host with no Apple Neural Engine — a ` +
      `GitHub-hosted CI runner — where CoreML falls back to the CPU for Kokoro synthesis and ` +
      `crashes on some inputs; shorter text or a \`macos-*\` AVSpeech voice avoids it there. ` +
      `On a physical Mac the cause is something else, so please report it: ` +
      `https://github.com/drakulavich/kesha-voice-kit/issues/742`
    );
  }
  return `${base}.`;
}

/**
 * The text contract both doors enforce, before anything that costs a subprocess.
 * Throws `SayError`; the CLI runs it before voice routing, `say()` for programmatic callers.
 */
export function validateSayText(text: string): void {
  if (text.trim().length === 0) {
    throw new SayError("text is empty", 2, "", "E_TEXT_EMPTY");
  }
  const chars = Array.from(text).length;
  if (chars > MAX_TEXT_CHARS) {
    throw new SayError(
      `text exceeds ${MAX_TEXT_CHARS} chars (${chars})`,
      5,
      "",
      "E_TEXT_TOO_LONG",
    );
  }
  if (text.includes("\0")) {
    throw new SayError("text contains a NUL byte", 2, "", "E_INVALID_ARG");
  }
}

export async function say(opts: SayOptions): Promise<Uint8Array> {
  const text = opts.text ?? "";
  validateSayText(text);

  if (!isEngineInstalled()) {
    throw new SayError(`kesha-engine not installed. run: ${installHint("--tts")}`, 1, "", "E_ENGINE_SPAWN");
  }
  const { argv: args, warnings } = validateArgv(buildSayArgs({ ...opts, text: undefined }), await getDescribe({ signal: opts.signal }));
  for (const warning of warnings) log.warn(warning);
  const { exitCode, signalCode, aborted, stdout, events } = await runEngineProcess(getEngineBinPath(), args, {
    stdio: ["pipe", "pipe", "pipe"],
    stdin: text,
    readStdout: (stream) => new Response(stream).arrayBuffer(),
    signal: opts.signal,
  });
  if (aborted) throw engineAbortError();

  const stderrText = events.stderr;
  if (exitCode === 0 && events.invalid.length === 0 && !events.error) {
    if (stderrText.length > 0) process.stderr.write(stderrText);
    return new Uint8Array(stdout);
  }
  const interrupted = interruptedRun(exitCode);
  if (interrupted) throw new SayError(interrupted.message, exitCodeFor(interrupted), "", interrupted.code);
  // The crash explanation rides in `stderr`, rendered after the coded line.
  const detail = [stderrText.trim(), engineCrashMessage(exitCode, signalCode)]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const failure = engineFailure("say", events, exitCode, detail);
  throw new SayError(failure.message, failure.exitCode || 4, failure.stderr ?? "", failure.code, failure.hint, failure.origin);
}

/** Installed voice ids as the engine lists them, one per line; a missing engine, a build without tts or a failed run is a KeshaError. */
export async function listVoiceIds(sinks: EventSinks = {}, signal?: AbortSignal): Promise<string[]> {
  if (!isEngineInstalled()) {
    throw new KeshaError("E_ENGINE_SPAWN", `kesha-engine not installed. run: ${installHint()}`);
  }
  if (signal?.aborted) throw engineAbortError();
  const { argv, warnings } = validateArgv(["say", "--list-voices"], await getDescribe({ signal }));
  for (const warning of warnings) log.warn(warning);
  const { exitCode, aborted, stdout: out, events } = await runEngineProcess(getEngineBinPath(), argv, {
    stdio: ["ignore", "pipe", "pipe"],
    readStdout: (stream) => new Response(stream).text(),
    sinks,
    signal,
  });
  if (aborted) throw engineAbortError();
  const interrupted = interruptedRun(exitCode);
  if (interrupted) throw interrupted;
  if (exitCode !== 0 || events.invalid.length > 0 || events.error) throw engineFailure("say --list-voices", events, exitCode);
  if (events.stderr.length > 0) process.stderr.write(events.stderr);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
