import { getEngineBinPath, isEngineInstalled } from "./engine";
import { log } from "./log";

export interface SayOptions {
  /**
   * Text to synthesize. Required for programmatic callers — `say()` does not
   * forward the host process's stdin. The CLI (`kesha say` with no positional
   * arg) handles stdin separately before invoking `say()`.
   */
  text?: string;
  /** Voice id, e.g. `en-af_heart`. Defaults to engine default. */
  voice?: string;
  /** Override the voice's default espeak language code. */
  lang?: string;
  /** Write audio to this path instead of returning bytes. */
  out?: string;
  /** Speaking rate 0.5–2.0. */
  rate?: number;
  /** Parse `text` as SSML (`<speak>…<break time="500ms"/>…</speak>`). See issue #122. */
  ssml?: boolean;
}

/** Build the argv passed to `kesha-engine say` (pure, unit-testable). */
export function buildSayArgs(o: SayOptions): string[] {
  const args: string[] = ["say"];
  if (o.voice) args.push("--voice", o.voice);
  if (o.lang) args.push("--lang", o.lang);
  if (o.out) args.push("--out", o.out);
  if (o.rate !== undefined && o.rate !== 1.0) args.push("--rate", String(o.rate));
  if (o.ssml) args.push("--ssml");
  if (o.text !== undefined && o.text.length > 0) args.push(o.text);
  return args;
}

export class SayError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "SayError";
  }
}

/**
 * Synthesize speech. Returns raw WAV bytes. If `out` is provided in options,
 * the engine writes to the file and this function returns an empty buffer.
 */
export async function say(opts: SayOptions): Promise<Uint8Array> {
  if (!isEngineInstalled()) {
    throw new SayError(
      "kesha-engine not installed. run: kesha install",
      1,
      "",
    );
  }
  const args = buildSayArgs({ ...opts, text: undefined });
  const startedAt = performance.now();
  log.debug(`spawn ${getEngineBinPath()} ${args.join(" ")} (text: ${opts.text?.length ?? 0} chars)`);
  const proc = Bun.spawn([getEngineBinPath(), ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.text !== undefined && opts.text.length > 0) {
    proc.stdin.write(opts.text);
    await proc.stdin.end();
  } else {
    await proc.stdin.end();
  }

  const [stdoutBuf, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  log.debug(`exit=${exitCode} dt=${Math.round(performance.now() - startedAt)}ms bytes=${stdoutBuf.byteLength}`);
  if (exitCode !== 0) {
    throw new SayError(
      stderrText.trim() || `kesha-engine say exited ${exitCode}`,
      exitCode,
      stderrText,
    );
  }
  return new Uint8Array(stdoutBuf);
}
