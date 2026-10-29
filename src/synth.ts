import { statSync } from "node:fs";
import { engineMissingError, getDescribe, getEngineBinPath, isEngineInstalled } from "./engine";
import { engineSignal, runEngineProcess } from "./engine/spawn";
import { validateArgv } from "./engine/describe";
import { engineFailure, exitCodeFor, KeshaError, SUPPORT_BUNDLE_HINT, type EventSinks } from "./engine/events";
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
type SupportedSampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];
export const MAX_TEXT_CHARS = 5000;
export const TEXT_TOO_LONG_HINT = `split the text into requests of at most ${MAX_TEXT_CHARS} characters`;

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
  if (o.out) args.push(`--out=${o.out}`);
  if (o.rate !== undefined && o.rate !== 1.0) args.push("--rate", String(o.rate));
  if (o.ssml) args.push("--ssml");
  if (o.format) args.push("--format", o.format);
  if (o.bitrate !== undefined) args.push("--bitrate", String(o.bitrate));
  if (o.sampleRate !== undefined) args.push("--sample-rate", String(o.sampleRate));
  if (o.noExpandAbbrev) args.push("--no-expand-abbrev");
  return args;
}

/** Explains a signal death, which leaves no error event. */
export function engineCrashMessage(exitCode: number, signalCode: string | null, platform: string = process.platform): string | null {
  const signal = engineSignal(exitCode, signalCode, platform);
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

// ©, ® and ™ stay, emoji presentation (U+FE0F) or not: read aloud they still mean something.
const KEPT_SYMBOL = /([©®™])️/g;
const EMOJI = /\p{RGI_Emoji}|[\p{Extended_Pictographic}--[©®™]]/gv;

/**
 * Emoji are decoration in a reply; a voice would read out their Unicode names (#1388).
 * Emoji-only SSML, tags aside, goes through unchanged, so the engine still refuses it as E_SCRIPT_UNSUPPORTED.
 */
function dropEmoji(text: string, ssml = false): string {
  const spoken = (ssml ? decodeCharRefs(text) : text).replace(KEPT_SYMBOL, "$1").replace(EMOJI, "");
  const speech = ssml ? spoken.replace(CDATA, "$1").replace(/<[^>]*>/g, "") : spoken;
  return speech.trim().length > 0 ? spoken : text;
}

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const NUMERIC_REF = /&#(?:x([0-9a-f]+)|(\d+));/gi;

/**
 * The engine decodes SSML character references, so `&#x1F60A;` is an emoji too. Decoding them first lets the
 * emoji filter see sequences spelled across references; CDATA keeps its text literal, and markup characters stay escaped.
 */
function decodeCharRefs(ssml: string): string {
  return ssml
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) =>
      part.startsWith("<![CDATA[")
        ? part
        : part.replace(NUMERIC_REF, (ref, hex?: string, dec?: string) => {
            const cp = hex !== undefined ? parseInt(hex, 16) : Number(dec);
            const plain = cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && !`<>&'"`.includes(String.fromCodePoint(cp));
            return plain ? String.fromCodePoint(cp) : ref;
          }),
    )
    .join("");
}

/**
 * The text contract both doors enforce, before anything that costs a subprocess.
 * Throws `KeshaError`; the CLI runs it before voice routing, `say()` for programmatic callers.
 */
export function validateSayText(text: string, ssml = false): void {
  if (text.trim().length === 0) {
    throw new KeshaError("E_TEXT_EMPTY", "text is empty", { exitCode: 2, stderr: "" });
  }
  if (!ssml && text.replace(KEPT_SYMBOL, "$1").replace(EMOJI, "").trim().length === 0) {
    throw new KeshaError("E_TEXT_EMPTY", "text has nothing to speak: emoji are not read aloud", {
      exitCode: 2,
      stderr: "",
    });
  }
  const chars = Array.from(text).length;
  if (chars > MAX_TEXT_CHARS) {
    throw new KeshaError("E_TEXT_TOO_LONG", `text exceeds ${MAX_TEXT_CHARS} chars (${chars})`, {
      exitCode: 5,
      stderr: "",
      hint: TEXT_TOO_LONG_HINT,
    });
  }
  if (text.includes("\0")) {
    throw new KeshaError("E_INVALID_ARG", "text contains a NUL byte", { exitCode: 2, stderr: "" });
  }
}

function outStamp(out: string | undefined): string | null {
  if (!out) return null;
  try {
    const s = statSync(out, { bigint: true });
    return `${s.ino}:${s.mtimeNs}:${s.size}`;
  } catch {
    return null;
  }
}

function missingAudio(out: string | undefined, stdoutBytes: number, before: string | null): string | null {
  if (!out) return stdoutBytes > 0 ? null : "no audio to stdout";
  try {
    if (statSync(out).size > 0 && outStamp(out) !== before) return null;
  } catch {}
  return `nothing to ${out}`;
}

export async function say(opts: SayOptions): Promise<Uint8Array> {
  const text = opts.text ?? "";
  validateSayText(text, opts.ssml);

  if (!isEngineInstalled()) {
    throw engineMissingError("speech synthesis", "--tts");
  }
  const { argv: args, warnings } = validateArgv(buildSayArgs(opts), await getDescribe({ signal: opts.signal }));
  for (const warning of warnings) log.warn(warning);
  const before = outStamp(opts.out);
  const { exitCode, signalCode, aborted, stdout, events } = await runEngineProcess(getEngineBinPath(), args, {
    stdio: ["pipe", "pipe", "pipe"],
    stdin: dropEmoji(text, opts.ssml),
    readStdout: (stream) => new Response(stream).arrayBuffer(),
    signal: opts.signal,
  });
  if (aborted) throw engineAbortError();

  const stderrText = events.stderr;
  if (exitCode === 0 && events.invalid.length === 0 && !events.error) {
    if (stderrText.length > 0) process.stderr.write(stderrText);
    const missing = missingAudio(opts.out, stdout.byteLength, before);
    if (missing)
      throw new KeshaError("E_INTERNAL", `kesha-engine exited 0 but wrote ${missing}`, {
        exitCode: 1,
        stderr: "",
        hint: SUPPORT_BUNDLE_HINT,
      });
    return new Uint8Array(stdout);
  }
  const interrupted = interruptedRun(exitCode);
  if (interrupted) {
    throw new KeshaError(interrupted.code, interrupted.message, { exitCode: exitCodeFor(interrupted), stderr: "" });
  }
  // The crash explanation rides in `stderr`, rendered after the coded line.
  const detail = [stderrText.trim(), engineCrashMessage(exitCode, signalCode)].filter((part): part is string => Boolean(part)).join("\n");
  const failure = engineFailure("say", events, exitCode, detail);
  throw new KeshaError(failure.code, failure.message, {
    exitCode: failure.exitCode || 4,
    stderr: failure.stderr ?? "",
    hint: failure.hint,
    origin: failure.origin,
  });
}

/** Installed voice ids as the engine lists them, one per line; a missing engine, a build without tts or a failed run is a KeshaError. */
export async function listVoiceIds(sinks: EventSinks = {}, signal?: AbortSignal): Promise<string[]> {
  if (!isEngineInstalled()) {
    throw engineMissingError("speech synthesis");
  }
  if (signal?.aborted) throw engineAbortError();
  const { argv, warnings } = validateArgv(["say", "--list-voices"], await getDescribe({ signal }));
  for (const warning of warnings) log.warn(warning);
  const {
    exitCode,
    aborted,
    stdout: out,
    events,
  } = await runEngineProcess(getEngineBinPath(), argv, {
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
