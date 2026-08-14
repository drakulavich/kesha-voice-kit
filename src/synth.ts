import {
  getEngineBinPath,
  isEngineInstalled,
  getEngineCapabilities,
  spawnEngineProcess,
  spawnStdioWithDebugFd,
  type EngineCapabilities,
} from "./engine";
import { engineErrorCode, TS_NATIVE_CODES } from "./error-codes";
import { installHint } from "./install-hint";
import { log } from "./log";
import { registerProcessTree } from "./process-tree";

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
  /**
   * Disable acronym auto-expansion. Honored for `ru-vosk-*` voices and for
   * `en-*` on ONNX engine builds; a no-op on FluidAudio Kokoro (the released
   * darwin-arm64 binary), `macos-*` and non-English voices, where the engine
   * owns initialism handling and warns on stderr instead (#842).
   * When true, passes `--no-expand-abbrev` to the engine (requires engine
   * capability `tts.ru_acronym_expansion` or `tts.en_acronym_expansion`).
   * On older engines that don't advertise the capability, the flag is
   * dropped from argv and `log.warn` surfaces the drop on every
   * invocation (post-#275 D3). `<say-as interpret-as="characters">`
   * still works regardless of this flag.
   */
  noExpandAbbrev?: boolean;
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

function applyNoExpandAbbrev(args: string[], capabilities: EngineCapabilities | null | undefined): void {
  const supportsAcronymExpansion =
    capabilities?.features?.some(
      (f) => f === "tts.ru_acronym_expansion" || f === "tts.en_acronym_expansion",
    ) ?? false;
  if (supportsAcronymExpansion) {
    args.push("--no-expand-abbrev");
  } else {
    // CLAUDE.md "NEVER SWALLOW ERRORS": the user explicitly passed the flag.
    // Silent drop with only `log.debug` made the flag look effective on old
    // engines (#275 D3). Surface it as a warning so a CI script or human
    // user sees the mismatch on every invocation, not only with --debug.
    log.warn(
      "--no-expand-abbrev requires kesha-engine ≥ 1.10.0 (advertises no tts.ru_acronym_expansion / tts.en_acronym_expansion capability); flag ignored",
    );
  }
}

/** Build the argv passed to `kesha-engine say` (pure, unit-testable). */
export function buildSayArgs(o: SayOptions, capabilities?: EngineCapabilities | null): string[] {
  const args: string[] = ["say"];
  if (o.voice) args.push("--voice", o.voice);
  if (o.lang) args.push("--lang", o.lang);
  if (o.out) args.push("--out", o.out);
  if (o.rate !== undefined && o.rate !== 1.0) args.push("--rate", String(o.rate));
  if (o.ssml) args.push("--ssml");
  if (o.format) args.push("--format", o.format);
  if (o.bitrate !== undefined) args.push("--bitrate", String(o.bitrate));
  if (o.sampleRate !== undefined) args.push("--sample-rate", String(o.sampleRate));
  if (o.noExpandAbbrev) applyNoExpandAbbrev(args, capabilities);
  if (o.text !== undefined && o.text.length > 0) args.push(o.text);
  return args;
}

export class SayError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
    public readonly code: string = "E_INTERNAL",
  ) {
    super(message);
    this.name = "SayError";
  }
}

/** Fault signals, by number. SIGBUS is 10 on darwin but 7 on linux. */
const FAULT_SIGNALS: Record<number, string> = { 4: "SIGILL", 6: "SIGABRT", 8: "SIGFPE", 11: "SIGSEGV" };

/**
 * Explain an engine death that produced no error of its own, or null when the
 * engine exited normally with a non-zero status. A signal kill leaves stderr
 * without an `error [CODE]:` line, so without this the caller only sees a bare
 * "exited 138".
 *
 * The wait status is the authority, not `signalCode`: Bun names signal 10
 * SIGUSR1 (its linux value) even on darwin, where it is SIGBUS.
 */
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

export async function say(opts: SayOptions): Promise<Uint8Array> {
  const text = opts.text ?? "";
  if (text.length === 0) {
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

  if (!isEngineInstalled()) {
    throw new SayError(
      `kesha-engine not installed. run: ${installHint("--tts")}`,
      1,
      "",
      TS_NATIVE_CODES.ENGINE_SPAWN,
    );
  }
  const capabilities = opts.noExpandAbbrev ? await getEngineCapabilities() : null;
  const args = buildSayArgs({ ...opts, text: undefined }, capabilities);
  const startedAt = performance.now();
  log.debug(`spawn ${getEngineBinPath()} ${args.join(" ")} (text: ${opts.text?.length ?? 0} chars)`);
  const proc = spawnEngineProcess(getEngineBinPath(), args, spawnStdioWithDebugFd(["pipe", "pipe", "pipe"]));
  const tree = registerProcessTree(proc);
  // spawnStdioWithDebugFd widens the tuple to a union; cast back to the known "pipe" types.
  const stdin = proc.stdin as Bun.FileSink;
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const stderr = proc.stderr as ReadableStream<Uint8Array>;

  if (opts.text !== undefined && opts.text.length > 0) stdin.write(opts.text);
  await stdin.end();

  let stdoutBuf: ArrayBuffer;
  let stderrText: string;
  let exitCode: number;
  try {
    [stdoutBuf, stderrText, exitCode] = await Promise.all([
      new Response(stdout).arrayBuffer(),
      new Response(stderr).text(),
      proc.exited,
    ]);
  } finally {
    tree.dispose();
  }

  log.debug(`exit=${exitCode} dt=${Math.round(performance.now() - startedAt)}ms bytes=${stdoutBuf.byteLength}`);

  // #275 D4: surface engine stderr on the success path so warnings like
  // `Model mirror active:` and the dtrace lines emitted under
  // KESHA_DEBUG=1 reach the user. Errors keep their existing path
  // through `SayError.stderr` so we don't double-print.
  if (exitCode === 0 && stderrText.length > 0) {
    process.stderr.write(stderrText.endsWith("\n") ? stderrText : stderrText + "\n");
  }
  if (exitCode !== 0) {
    // The crash line goes into `stderr` too: `cli/say.ts` prints that in
    // preference to the message, and a crash leaves progress lines behind that
    // would otherwise hide the diagnosis.
    const detail = [stderrText.trim(), engineCrashMessage(exitCode, proc.signalCode)]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    throw new SayError(
      detail || `kesha-engine say exited ${exitCode}`,
      exitCode,
      detail,
      engineErrorCode(stderrText),
    );
  }
  return new Uint8Array(stdoutBuf);
}
