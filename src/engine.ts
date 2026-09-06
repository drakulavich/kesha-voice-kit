import { existsSync, statSync } from "fs";
import { errorMessage } from "./error-utils";
import { join } from "path";
import { installHint } from "./install-hint";
import { log } from "./log";
import { defaultEngineBinPath, keshaCacheDir } from "./paths";
import { engineAbortError, registerProcessTree } from "./process-tree";
import { engineFailure, KeshaError, readEvents, type ErrorEvent } from "./engine/events";
import {
  describeToCapabilities,
  parseDescribe,
  protocolMismatch,
  validateArgv,
  type DescribeDocument,
  type EngineCapabilities,
  type TtsLanguageCapability,
  PROTOCOL_VERSION,
} from "./engine/describe";

export type { EngineCapabilities, TtsLanguageCapability };

/**
 * Capability-flag string for speaker diarization. Engine advertises this only
 * on darwin-arm64 builds with the `system_diarize` cargo feature (#199).
 * Mirrors `rust/src/transcribe/mod.rs::TRANSCRIBE_DIARIZE_FEATURE`.
 */
export const TRANSCRIBE_DIARIZE_FEATURE = "transcribe.diarize";

export interface LangDetectResult {
  code: string;
  confidence: number;
}

/**
 * One word of a segment, on the same file-relative clock as the segment, so a
 * word span always lies inside its segment.
 *
 * Times come from the ASR's own frame grid: they are quantised to 0.08 s, and
 * `end` is a per-token duration prediction rather than the next word's `start`,
 * so consecutive spans may overlap and do not partition the segment. `word` is
 * what the decoder emitted, punctuation attached (#720).
 *
 * `end >= start`, not `end > start` — a word clipped at the segment boundary can
 * be zero-width, because the duration head can predict past the end of its audio.
 */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  /** Speaker cluster id when `--speakers` was requested (#199). */
  speaker?: number;
  /** Per-word timings; absent on engines without `transcribe.words` (#720). */
  words?: WordTiming[];
}

export interface TranscriptionOutput {
  text: string;
  segments: TranscriptionSegment[];
}

/** `KESHA_ENGINE_BIN` overrides the default install path — used in dev and e2e tests. An empty string is treated as unset, not as "use ''". */
export function getEngineBinPath(): string {
  return process.env.KESHA_ENGINE_BIN || defaultEngineBinPath();
}

export function isEngineInstalled(): boolean {
  return existsSync(getEngineBinPath());
}

type SpawnStdioEntry = "inherit" | "pipe" | "ignore";
export type SpawnStdio = [SpawnStdioEntry, SpawnStdioEntry, SpawnStdioEntry];

/** The env for a spawn whose stderr is parsed as protocol 4 events. */
export function protocolEnv(): Record<string, string | undefined> {
  return { ...process.env, KESHA_PROTOCOL: String(PROTOCOL_VERSION) };
}

function spawnHint(): string {
  return process.env.KESHA_ENGINE_BIN
    ? "KESHA_ENGINE_BIN points at it; fix the path or unset it and run `kesha install`"
    : "run `kesha install`";
}

/** `Bun.spawn` throws synchronously on ENOENT/EACCES; every launch failure becomes `E_ENGINE_SPAWN`. */
export function spawnEngineProcess(
  binPath: string,
  args: string[],
  stdio: SpawnStdio,
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof Bun.spawn> {
  try {
    // `env` is passed explicitly: Bun snapshots process.env at startup otherwise (#874).
    return Bun.spawn([binPath, ...args], { detached: true, stdio, env });
  } catch (err) {
    throw new KeshaError("E_ENGINE_SPAWN", `failed to launch kesha-engine at ${binPath}: ${errorMessage(err)}`, {
      hint: spawnHint(),
    });
  }
}

export interface RunEngineOptions {
  signal?: AbortSignal;
  /** Receives each progress line as the engine writes it, rather than once the run is
   *  over (#1002). Progress the caller takes delivery of this way is dropped from the
   *  returned `stderr`, so it is never shown a second time in the failure report. */
  onProgressLine?: (line: string) => void;
}

interface EngineRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  error: ErrorEvent | null;
  invalid: string[];
}

async function runEngine(args: string[], opts: RunEngineOptions = {}): Promise<EngineRun> {
  if (opts.signal?.aborted) throw engineAbortError();
  const binPath = getEngineBinPath();
  const startedAt = performance.now();
  log.debug(`spawn ${binPath} ${args.join(" ")}`);
  const proc = spawnEngineProcess(binPath, args, ["ignore", "pipe", "pipe"], protocolEnv());
  const tree = registerProcessTree(proc);
  let aborted = false;
  let forceKillTimer: Timer | undefined;
  const abort = () => {
    aborted = true;
    tree.terminate("SIGTERM");
    forceKillTimer ??= tree.forceKillAfterGrace();
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  let stdout: string;
  let events: Awaited<ReturnType<typeof readEvents>>;
  let exitCode: number;
  try {
    [stdout, events, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      readEvents(proc.stderr as ReadableStream<Uint8Array>, { onProgress: opts.onProgressLine }),
      proc.exited,
    ]);
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    tree.dispose();
    if (!aborted && forceKillTimer) clearTimeout(forceKillTimer);
  }
  log.debug(`exit=${exitCode} dt=${Math.round(performance.now() - startedAt)}ms args=${JSON.stringify(args)}`);
  if (aborted) {
    log.debug(`aborted args=${JSON.stringify(args)}`);
    throw engineAbortError();
  }
  const stderr = events.stderr.trim();
  // #275 D4: warnings reach the user on success; on failure they travel inside the KeshaError.
  if (exitCode === 0 && events.invalid.length === 0 && events.error === null && stderr.length > 0)
    process.stderr.write(`${stderr}\n`);
  return { stdout: stdout.trim(), stderr, exitCode, error: events.error, invalid: events.invalid };
}

function failed(run: EngineRun): boolean {
  return run.exitCode !== 0 || run.invalid.length > 0 || run.error !== null;
}

let cachedDescribe: { binPath: string; mtime: number; doc: DescribeDocument } | null = null;

/** The describe document of the installed engine, cached until the binary changes (#248). */
export async function getDescribe(opts: RunEngineOptions = {}): Promise<DescribeDocument> {
  const binPath = getEngineBinPath();
  let mtime: number;
  try {
    mtime = statSync(binPath).mtimeMs;
  } catch (err) {
    throw new KeshaError("E_ENGINE_SPAWN", `kesha-engine not found at ${binPath}: ${errorMessage(err)}`, {
      hint: spawnHint(),
    });
  }
  if (cachedDescribe?.binPath === binPath && cachedDescribe.mtime === mtime) return cachedDescribe.doc;
  const run = await runEngine(["describe"], opts);
  let doc: DescribeDocument | null = null;
  if (run.exitCode === 0) {
    try {
      doc = parseDescribe(JSON.parse(run.stdout));
    } catch {
      doc = null;
    }
  }
  if (!doc) {
    // An error event names the engine-side cause and carries the engine's own exit status; a non-event line is still the generic protocol fault, with the install hint.
    if (run.error) throw engineFailure("describe", run, run.exitCode);
    throw new KeshaError("E_ENGINE_PROTOCOL", `kesha-engine at ${binPath} did not answer \`describe\``, {
      hint: "run `kesha install` to fetch the engine this CLI expects",
    });
  }
  const mismatch = protocolMismatch(doc, binPath);
  if (mismatch) throw mismatch;
  if (run.invalid.length > 0) throw engineFailure("describe", run, undefined);
  cachedDescribe = { binPath, mtime, doc };
  return doc;
}

/** Capabilities view for the screens that predate `describe`; null when the engine cannot be read. */
export async function getEngineCapabilities(opts: RunEngineOptions = {}): Promise<EngineCapabilities | null> {
  try {
    return describeToCapabilities(await getDescribe(opts));
  } catch (err) {
    if (err instanceof KeshaError) return null;
    throw err;
  }
}

async function validatedArgs(args: string[], opts: RunEngineOptions): Promise<string[]> {
  const { argv, warnings } = validateArgv(args, await getDescribe(opts));
  for (const warning of warnings) log.warn(warning);
  return argv;
}

/** VAD preprocessing selector.
 *  - `"auto"` (default): engine decides — VAD when audio ≥ 120 s and model installed
 *  - `"on"`: force VAD (requires `kesha install --vad`)
 *  - `"off"`: force full-file ASR for short/medium files; long audio fails early
 */
export type VadMode = "auto" | "on" | "off";

export interface TranscribeEngineOptions {
  vad?: VadMode;
  signal?: AbortSignal;
  /** Request speaker labels in transcript segments. Requires the engine to
   * advertise `transcribe.diarize` (darwin-arm64 only — see #199). */
  speakers?: boolean;
  /** Rewrite spoken-form numbers to written form. Requires the engine to
   * advertise `transcribe.itn` (#710). */
  itn?: boolean;
  /** See {@link RunEngineOptions.onProgressLine}. */
  onProgressLine?: (line: string) => void;
}

function defaultDiarizeModelPath(): string {
  return join(keshaCacheDir(), "models", "diarize", "SortformerNvidiaLow_v2.mlpackage");
}

function hasDiarizeModelLayout(modelPath: string): boolean {
  return (
    existsSync(join(modelPath, "Manifest.json")) &&
    existsSync(join(modelPath, "Data", "com.apple.CoreML", "model.mlmodel")) &&
    existsSync(join(modelPath, "Data", "com.apple.CoreML", "weights", "0-weight.bin")) &&
    existsSync(join(modelPath, "Data", "com.apple.CoreML", "weights", "1-weight.bin"))
  );
}

function assertDiarizeModelInstalled(): void {
  const envPath = process.env.KESHA_DIARIZE_MODEL_PATH;
  if (envPath !== undefined) {
    if (existsSync(envPath)) return;
    throw new KeshaError(
      "E_MODEL_MISSING",
      `speaker diarization requires a model path: KESHA_DIARIZE_MODEL_PATH set but path does not exist: ${envPath}`,
      { hint: `point KESHA_DIARIZE_MODEL_PATH at the model, or unset it and run \`${installHint("--diarize")}\`` },
    );
  }

  const modelPath = defaultDiarizeModelPath();
  if (hasDiarizeModelLayout(modelPath)) return;
  throw new KeshaError(
    "E_MODEL_MISSING",
    `speaker diarization requires a model path: diarization model not found at ${modelPath}`,
    { hint: `run \`${installHint("--diarize")}\` (or set KESHA_DIARIZE_MODEL_PATH)` },
  );
}

/** #768: `--speakers` forces VAD windowing, so the VAD model is a hard dependency. */
function assertVadModelInstalled(): void {
  const modelPath = join(keshaCacheDir(), "models", "silero-vad", "silero_vad.onnx");
  if (existsSync(modelPath)) return;
  throw new KeshaError(
    "E_MODEL_MISSING",
    `speaker diarization requires the VAD model: --speakers windows the audio with Silero VAD so each speech span can be labeled; VAD model not found at ${modelPath}`,
    { hint: `run \`${installHint("--vad")}\`` },
  );
}

/** Model files the engine will look for; the argv itself was already checked against the schema. */
export function assertSpeakerModelsInstalled(): void {
  assertDiarizeModelInstalled();
  assertVadModelInstalled();
}

function vadArg(vad: VadMode | undefined): string[] {
  if (vad === "on") return ["--vad"];
  if (vad === "off") return ["--no-vad"];
  return [];
}

/** Build the argv passed to `kesha-engine transcribe` (pure, unit-testable). */
export function buildTranscribeArgs(
  audioPath: string,
  opts: TranscribeEngineOptions,
  json = false,
): string[] {
  const args = ["transcribe", audioPath, ...(json ? ["--json"] : []), ...vadArg(opts.vad)];
  if (opts.itn) args.push("--itn");
  if (json && opts.speakers) args.push("--speakers");
  return args;
}

export async function transcribeEngine(audioPath: string, opts: TranscribeEngineOptions = {}): Promise<string> {
  const args = await validatedArgs(buildTranscribeArgs(audioPath, opts), { signal: opts.signal });
  const run = await runEngine(args, { signal: opts.signal, onProgressLine: opts.onProgressLine });
  if (failed(run)) throw engineFailure(args[0] ?? "", run, run.exitCode);
  return run.stdout;
}

/**
 * Validate an engine-supplied `words` array, or return `undefined` when the key is
 * absent or malformed. Unlike `start`/`end`/`text`, a garbled optional enrichment
 * must not cost the caller their transcript, so this drops rather than throws (#720).
 */
function parseWordTimings(raw: unknown): WordTiming[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words: WordTiming[] = [];
  for (const entry of raw) {
    const w = entry as Record<string, unknown> | null;
    if (
      typeof w?.word !== "string" ||
      typeof w.start !== "number" ||
      typeof w.end !== "number"
    ) {
      return undefined;
    }
    words.push({ word: w.word, start: w.start, end: w.end });
  }
  return words;
}

export function parseTranscriptionOutput(stdout: string): TranscriptionOutput {
  const parsed = JSON.parse(stdout);
  if (typeof parsed?.text !== "string" || !Array.isArray(parsed?.segments)) {
    throw new KeshaError("E_INTERNAL", "Invalid transcription JSON returned by kesha-engine");
  }

  const segments = parsed.segments.map((segment: unknown) => {
    const s = segment as Record<string, unknown>;
    if (
      typeof s.start !== "number" ||
      typeof s.end !== "number" ||
      typeof s.text !== "string"
    ) {
      throw new KeshaError("E_INTERNAL", "Invalid transcription segment returned by kesha-engine");
    }
    const out: TranscriptionSegment = { start: s.start, end: s.end, text: s.text };
    if (typeof s.speaker === "number") out.speaker = s.speaker;
    const words = parseWordTimings(s.words);
    if (words) out.words = words;
    return out;
  });

  return { text: parsed.text, segments };
}

export async function transcribeEngineWithSegments(
  audioPath: string,
  opts: TranscribeEngineOptions = {},
): Promise<TranscriptionOutput> {
  const args = await validatedArgs(buildTranscribeArgs(audioPath, opts, true), { signal: opts.signal });
  if (opts.speakers) assertSpeakerModelsInstalled();
  const run = await runEngine(args, { signal: opts.signal, onProgressLine: opts.onProgressLine });
  if (failed(run)) throw engineFailure(args[0] ?? "", run, run.exitCode);
  try {
    return parseTranscriptionOutput(run.stdout);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KeshaError(err instanceof KeshaError ? err.code : "E_INTERNAL", `${message}: ${run.stdout}`);
  }
}

/** Either capture to a WAV or transcribe live — the Engine rejects both at once. */
export interface LiveAutoStopOptions {
  silenceMs: number;
  threshold: number;
  minSpeechMs: number;
}

export type RecordTarget =
  | { live: true; autoStop?: LiveAutoStopOptions }
  | { live?: false; out: string };

/**
 * A live session catches SIGINT/SIGTERM, prints the transcript it has and then
 * exits 128+signal, so these two codes mean the run succeeded and was cancelled
 * — not that it failed (#962). `--out` installs no handler, so a signalled
 * capture really did lose its recording and still reports as a failure.
 */
const SIGNALLED_LIVE_EXIT_CODES = new Set([130, 143]);

export function buildRecordArgs(target: RecordTarget, maxSeconds: number): string[] {
  if (!target.live) return ["record", "--out", target.out, "--max-seconds", String(maxSeconds)];
  const args = ["record", "--live", "--max-seconds", String(maxSeconds)];
  if (target.autoStop) {
    args.push(
      "--auto-stop",
      "--auto-stop-silence-ms",
      String(target.autoStop.silenceMs),
      "--auto-stop-threshold",
      String(target.autoStop.threshold),
      "--auto-stop-min-speech-ms",
      String(target.autoStop.minSpeechMs),
    );
  }
  return args;
}

/** Refuses a record argv the installed engine cannot serve before anything is spawned. */
export async function validateRecordRequest(target: RecordTarget, maxSeconds: number): Promise<void> {
  validateArgv(buildRecordArgs(target, maxSeconds), await getDescribe());
}

export async function recordEngine(target: RecordTarget, maxSeconds: number): Promise<void> {
  const binPath = getEngineBinPath();
  const args = buildRecordArgs(target, maxSeconds);
  const startedAt = performance.now();
  log.debug(`spawn ${binPath} ${args.join(" ")}`);
  const proc = spawnEngineProcess(binPath, args, ["inherit", "inherit", "inherit"]);
  const tree = registerProcessTree(proc);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    tree.dispose();
  }
  log.debug(`exit=${exitCode} dt=${Math.round(performance.now() - startedAt)}ms args=${JSON.stringify(args)}`);
  if (exitCode !== 0 && !(target.live && SIGNALLED_LIVE_EXIT_CODES.has(exitCode))) {
    throw new Error(`kesha-engine record exited with code ${exitCode}`);
  }
}

export function parseLangResult(stdout: string): LangDetectResult | null {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.code !== "string" || typeof parsed.confidence !== "number") {
      return null;
    }
    return { code: parsed.code, confidence: parsed.confidence };
  } catch {
    return null;
  }
}

export async function detectAudioLanguageEngine(
  audioPath: string,
  opts: RunEngineOptions = {},
): Promise<LangDetectResult | null> {
  if (!isEngineInstalled()) return null;
  const { stdout, exitCode } = await runEngine(["detect-lang", audioPath], opts);
  if (exitCode !== 0) return null;
  return parseLangResult(stdout);
}

export async function detectTextLanguageEngine(
  text: string,
  opts: RunEngineOptions = {},
): Promise<LangDetectResult | null> {
  if (text.trim().length === 0) return null;
  if (!isEngineInstalled()) return null;
  const { stdout, stderr, exitCode } = await runEngine(["detect-text-lang", text], opts);
  if (exitCode !== 0) {
    const warning = textLangFailureWarning(stderr);
    if (warning) log.warn(warning);
    return null;
  }
  return parseLangResult(stdout);
}

/**
 * Null off darwin, where text detection is unsupported by design and failing is expected.
 *
 * On darwin a failure means a broken `kesha-textlang` sidecar, and swallowing it routed
 * `kesha say` to the default voice with no hint that detection had stopped working (#770).
 */
export function textLangFailureWarning(
  stderr: string,
  platform: string = process.platform,
): string | null {
  if (platform !== "darwin") return null;
  return (
    `Text language detection failed${stderr ? `: ${stderr}` : ""}\n` +
    "  Falling back to the default voice. Fix: run `kesha install` to reinstall the kesha-textlang sidecar."
  );
}

