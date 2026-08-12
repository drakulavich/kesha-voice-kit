import { existsSync, statSync } from "fs";
import { errorMessage } from "./error-utils";
import { TS_NATIVE_CODES } from "./error-codes";
import { join } from "path";
import { installHint } from "./install-hint";
import { log } from "./log";
import { defaultEngineBinPath, keshaCacheDir } from "./paths";
import { engineAbortError, registerProcessTree } from "./process-tree";

/**
 * Capability-flag string surfaced via `kesha-engine --capabilities-json`. Single
 * source of truth so the engine, the TS CLI gate, and the integration tests
 * can't drift. Mirrors `rust/src/transcribe/mod.rs::TRANSCRIBE_SEGMENTS_FEATURE`.
 */
export const TRANSCRIBE_SEGMENTS_FEATURE = "transcribe.segments";

/**
 * Capability-flag string for speaker diarization. Engine advertises this only
 * on darwin-arm64 builds with the `system_diarize` cargo feature (#199).
 * Mirrors `rust/src/transcribe/mod.rs::TRANSCRIBE_DIARIZE_FEATURE`.
 */
export const TRANSCRIBE_DIARIZE_FEATURE = "transcribe.diarize";
/** Mirrors `rust/src/record.rs::RECORD_LIVE_FEATURE`. */
export const RECORD_LIVE_FEATURE = "record.live";

/**
 * Capability-flag string for the opt-in written-form (ITN) pass. Every engine
 * built since #710 advertises it regardless of backend, so a missing entry
 * means the installed engine predates the feature.
 * Mirrors `rust/src/transcribe/mod.rs::TRANSCRIBE_ITN_FEATURE`.
 */
export const TRANSCRIBE_ITN_FEATURE = "transcribe.itn";

/**
 * Capability-flag string for per-word timings inside timestamped segments.
 * Backend-gated: ONNX builds advertise it, CoreML builds don't (#720).
 * Mirrors `rust/src/transcribe/mod.rs::TRANSCRIBE_WORDS_FEATURE`.
 */
export const TRANSCRIBE_WORDS_FEATURE = "transcribe.words";

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

/** A Bun.spawn `stdio` array entry: per-fd action or inherit-by-number. */
type SpawnStdioEntry = "inherit" | "pipe" | "ignore" | number;

/** #323 Greptile P2: index-addressed stdio array — cap to POSIX RLIMIT_NOFILE default to guard against DoS via huge fd values. */
const MAX_FORWARDED_FD = 1024;

/**
 * Build a `stdio` array for `Bun.spawn`, forwarding `KESHA_DEBUG_FD` (#321 F19).
 *
 * Bun.spawn closes non-stdio fds in the child by default, so the env var alone
 * isn't enough — we must pass fd N explicitly via `stdio[N] = N`.
 * Exported so `synth.ts` can share this without duplicating the env-parse.
 */
export function spawnStdioWithDebugFd(
  base: [SpawnStdioEntry, SpawnStdioEntry, SpawnStdioEntry],
): [SpawnStdioEntry, SpawnStdioEntry, SpawnStdioEntry, ...SpawnStdioEntry[]] {
  const envFd = process.env.KESHA_DEBUG_FD;
  if (!envFd) return base;
  const fd = Number(envFd);
  if (!Number.isInteger(fd) || fd < 3 || fd > MAX_FORWARDED_FD) return base;
  const out: SpawnStdioEntry[] = [...base];
  while (out.length < fd) out.push("ignore");
  out[fd] = fd;
  return out as [SpawnStdioEntry, SpawnStdioEntry, SpawnStdioEntry, ...SpawnStdioEntry[]];
}

export interface RunEngineOptions {
  signal?: AbortSignal;
}

/**
 * `Bun.spawn` throws synchronously on any spawn failure (ENOENT, EACCES, …)
 * instead of failing async, so a missing/non-executable binary would
 * otherwise surface as a raw runtime stack trace. Re-throw every such
 * failure through the same `E_ENGINE_SPAWN` code `src/synth.ts` uses
 * (docs/errors.md).
 */
export function spawnEngineProcess(
  binPath: string,
  args: string[],
  stdio: ReturnType<typeof spawnStdioWithDebugFd>,
): ReturnType<typeof Bun.spawn> {
  try {
    // Bun snapshots `process.env` at startup unless `env` is passed, so anything the CLI
    // resolves at runtime — `NO_COLOR` from `--no-color`, a `KESHA_*` override — reached the
    // parent and not the engine (#874).
    return Bun.spawn([binPath, ...args], { detached: true, stdio, env: process.env });
  } catch (err) {
    throw new Error(
      `error [${TS_NATIVE_CODES.ENGINE_SPAWN}]: failed to launch kesha-engine at ${binPath}: ` +
        `${errorMessage(err)}. Run \`kesha install\` (or set KESHA_ENGINE_BIN).`,
    );
  }
}

async function runEngine(
  args: string[],
  opts: RunEngineOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (opts.signal?.aborted) throw engineAbortError();
  const binPath = getEngineBinPath();
  const startedAt = performance.now();
  log.debug(`spawn ${binPath} ${args.join(" ")}`);
  const proc = spawnEngineProcess(binPath, args, spawnStdioWithDebugFd(["ignore", "pipe", "pipe"]));
  const tree = registerProcessTree(proc);
  let aborted = false;
  let forceKillTimer: Timer | undefined;
  const abort = () => {
    aborted = true;
    tree.terminate("SIGTERM");
    forceKillTimer ??= tree.forceKillAfterGrace();
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  // `stdio: [...]` widens stdout/stderr into a union; indices 1/2 are
  // pinned to "pipe" by the helper, so the narrow ReadableStream type
  // is correct. Cast to drop the spurious `number` arm.
  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(stdoutStream).text(),
      new Response(stderrStream).text(),
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

  // #275 D4: forward engine warnings (hints, mirror notices, KESHA_DEBUG lines) on success;
  // on failure, leave stderr for callers to fold into the thrown Error (avoids duplicate output).
  if (exitCode === 0 && stderr.length > 0) {
    process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
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
}

/** #768: speakers force VAD windowing, so `vad: "off"` is an invalid pair. Callers
 * must run this before any capability or model resolution — an invalid request
 * has to read as invalid whatever happens to be installed. */
export function assertSpeakersVadCompatible(opts: TranscribeEngineOptions): void {
  if (!opts.speakers || opts.vad !== "off") return;
  throw new Error(
    `error [${TS_NATIVE_CODES.INVALID_ARG}]: speakers cannot be combined with vad: "off": ` +
      "speaker labels attach to VAD-windowed speech segments, and disabling VAD leaves the " +
      'whole file as one segment with nothing to label. Drop vad: "off" (VAD engages ' +
      "automatically for speakers), or drop speakers.",
  );
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
    throw new Error(
      `speaker diarization requires a model path\n\nCaused by:\n    KESHA_DIARIZE_MODEL_PATH set but path does not exist: ${envPath}`,
    );
  }

  const modelPath = defaultDiarizeModelPath();
  if (hasDiarizeModelLayout(modelPath)) return;
  throw new Error(
    `speaker diarization requires a model path\n\nCaused by:\n    diarization model not found at ${modelPath}. ` +
      `Run \`${installHint("--diarize")}\` (or set KESHA_DIARIZE_MODEL_PATH).`,
  );
}

/** #768: `--speakers` forces VAD windowing, so the VAD model is a hard dependency. */
function assertVadModelInstalled(): void {
  const modelPath = join(keshaCacheDir(), "models", "silero-vad", "silero_vad.onnx");
  if (existsSync(modelPath)) return;
  throw new Error(
    "speaker diarization requires the VAD model: --speakers windows the audio with Silero VAD " +
      `so each speech span can be labeled.\n\nCaused by:\n    VAD model not found at ${modelPath}. ` +
      `Run \`${installHint("--vad")}\`.`,
  );
}

/**
 * Gate `--itn` on the engine advertising it, per the "don't blindly forward
 * flags" rule. Unlike `--speakers` this is not a platform gate — every backend
 * supports the pass — so a missing capability means the installed engine is
 * older than the CLI asking for it.
 */
export function assertItnSupported(caps: EngineCapabilities | null): void {
  if (!caps?.features.includes(TRANSCRIBE_ITN_FEATURE)) {
    throw new Error(
      "--itn requires a newer kesha-engine: the installed engine does not advertise " +
        `${TRANSCRIBE_ITN_FEATURE}.\n\n` +
        "Upgrade Kesha Voice Kit, then replace the engine:\n\n" +
        "    bun add -g @drakulavich/kesha-voice-kit@latest\n" +
        `    ${installHint()}`,
    );
  }
}

export async function preflightTranscribeEngineItn(
  opts: TranscribeEngineOptions = {},
): Promise<void> {
  if (!opts.itn) return;
  assertItnSupported(await getEngineCapabilities());
}

export async function preflightTranscribeEngineWithSegments(
  opts: TranscribeEngineOptions = {},
): Promise<void> {
  assertSpeakersVadCompatible(opts);

  const caps = await getEngineCapabilities();
  if (!caps?.features.includes(TRANSCRIBE_SEGMENTS_FEATURE)) {
    throw new Error(
      "Timestamped segments require a newer kesha-engine. Run `kesha install` after upgrading Kesha Voice Kit.",
    );
  }

  if (!opts.speakers) return;

  assertSpeakersSupported(caps);
  assertDiarizeModelInstalled();
  assertVadModelInstalled();
}

export function assertSpeakersSupported(caps: EngineCapabilities | null): void {
  if (!caps?.features.includes(TRANSCRIBE_DIARIZE_FEATURE)) {
    throw new Error(
      "speaker diarization is currently darwin-arm64 only " +
        "(see https://github.com/drakulavich/kesha-voice-kit/issues/199)",
    );
  }
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

export async function transcribeEngine(
  audioPath: string,
  opts: TranscribeEngineOptions = {},
): Promise<string> {
  await preflightTranscribeEngineItn(opts);

  const args = buildTranscribeArgs(audioPath, opts);
  const { stdout, stderr, exitCode } = await runEngine(args, { signal: opts.signal });
  if (exitCode !== 0) {
    throw new Error(stderr || `kesha-engine exited with code ${exitCode}`);
  }
  return stdout;
}

function parseTranscriptionOutput(stdout: string): TranscriptionOutput {
  const parsed = JSON.parse(stdout);
  if (typeof parsed?.text !== "string" || !Array.isArray(parsed?.segments)) {
    throw new Error("Invalid transcription JSON returned by kesha-engine");
  }

  const segments = parsed.segments.map((segment: unknown) => {
    const s = segment as Record<string, unknown>;
    if (
      typeof s.start !== "number" ||
      typeof s.end !== "number" ||
      typeof s.text !== "string"
    ) {
      throw new Error("Invalid transcription segment returned by kesha-engine");
    }
    const out: TranscriptionSegment = { start: s.start, end: s.end, text: s.text };
    if (typeof s.speaker === "number") out.speaker = s.speaker;
    return out;
  });

  return { text: parsed.text, segments };
}

export async function transcribeEngineWithSegments(
  audioPath: string,
  opts: TranscribeEngineOptions = {},
): Promise<TranscriptionOutput> {
  await preflightTranscribeEngineItn(opts);
  await preflightTranscribeEngineWithSegments(opts);

  const args = buildTranscribeArgs(audioPath, opts, true);
  const { stdout, stderr, exitCode } = await runEngine(args, { signal: opts.signal });
  if (exitCode !== 0) {
    throw new Error(stderr || `kesha-engine exited with code ${exitCode}`);
  }
  try {
    return parseTranscriptionOutput(stdout);
  } catch (err: unknown) {
    const message = errorMessage(err);
    throw new Error(`${message}: ${stdout}`);
  }
}

/** Live transcription needs the Engine's streaming ASR session, which only the
 * CoreML backend on Apple Silicon compiles. Refuses here rather than letting the
 * Engine answer with `E_UNSUPPORTED_PLATFORM` after the spawn. */
export async function preflightRecordLive(): Promise<void> {
  const caps = await getEngineCapabilities().catch(() => null);
  if (caps === null) {
    throw new Error(
      "could not read kesha-engine's capabilities, so --live cannot be verified.\n\n" +
        "The engine binary failed to answer `--capabilities-json` — it may be missing, " +
        "truncated, or blocked from running.\n\n" +
        `Reinstall it and retry:\n\n    ${installHint()}`,
    );
  }
  if (!caps.features.includes(RECORD_LIVE_FEATURE)) {
    throw new Error(
      "live transcription requires a CoreML engine on Apple Silicon.\n\n" +
        "On this platform, record and transcribe in two steps:\n\n" +
        "    kesha record --out note.wav\n" +
        "    kesha note.wav",
    );
  }
}

/** Either capture to a WAV or transcribe live — the Engine rejects both at once. */
export type RecordTarget = { live: true } | { live?: false; out: string };

export async function recordEngine(target: RecordTarget, maxSeconds: number): Promise<void> {
  const binPath = getEngineBinPath();
  const args = target.live
    ? ["record", "--live", "--max-seconds", String(maxSeconds)]
    : ["record", "--out", target.out, "--max-seconds", String(maxSeconds)];
  const startedAt = performance.now();
  log.debug(`spawn ${binPath} ${args.join(" ")}`);
  const proc = spawnEngineProcess(binPath, args, spawnStdioWithDebugFd(["inherit", "inherit", "inherit"]));
  const tree = registerProcessTree(proc);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    tree.dispose();
  }
  log.debug(`exit=${exitCode} dt=${Math.round(performance.now() - startedAt)}ms args=${JSON.stringify(args)}`);
  if (exitCode !== 0) {
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

export interface TtsLanguageCapability {
  code: string;
  engines: string[];
}

export interface EngineCapabilities {
  protocolVersion: number;
  backend: string;
  features: string[];
  tts?: { languages: TtsLanguageCapability[] };
}

let cachedEngineCapabilities:
  | { binPath: string; mtime: number; capabilities: EngineCapabilities }
  | null = null;

export async function getEngineCapabilities(
  opts: RunEngineOptions = {},
): Promise<EngineCapabilities | null> {
  const binPath = getEngineBinPath();
  // #248: include mtimeMs so an in-place `kesha install` overwite invalidates the cache.
  // statSync throws on missing file — catch returns null, no separate isEngineInstalled() needed.
  let mtime: number;
  try {
    mtime = statSync(binPath).mtimeMs;
  } catch {
    return null;
  }
  if (
    cachedEngineCapabilities?.binPath === binPath &&
    cachedEngineCapabilities.mtime === mtime
  ) {
    return cachedEngineCapabilities.capabilities;
  }
  const { stdout, exitCode } = await runEngine(["--capabilities-json"], opts);
  if (exitCode !== 0) return null;
  try {
    const capabilities = parseCapabilities(JSON.parse(stdout));
    if (!capabilities) return null;
    cachedEngineCapabilities = { binPath, mtime, capabilities };
    return capabilities;
  } catch {
    return null;
  }
}

// A non-null return must mean "it described itself" — callers reach straight for `.features.join()` (#647).
function parseCapabilities(parsed: unknown): EngineCapabilities | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { protocolVersion, backend, features } = parsed as Record<string, unknown>;
  if (typeof protocolVersion !== "number") return null;
  if (typeof backend !== "string") return null;
  if (!Array.isArray(features) || features.some((f) => typeof f !== "string")) return null;
  return parsed as EngineCapabilities;
}
