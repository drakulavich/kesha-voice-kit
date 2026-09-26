import { errorMessage } from "../error-utils";
import { log } from "../log";
import { abortOnSignal, engineAbortError, pendingInterruption, registerProcessTree } from "../process-tree";
import { resolveStatePaths } from "../state-paths";
import { PROTOCOL_VERSION } from "./describe";
import { KeshaError, readEvents, type EventSinks, type StderrOutcome } from "./events";

type SpawnStdioEntry = "inherit" | "pipe" | "ignore";
type SpawnStdio = [SpawnStdioEntry, SpawnStdioEntry, SpawnStdioEntry];
type EngineProcess = ReturnType<typeof Bun.spawn>;

/** The env for a spawn whose stderr is parsed as protocol 4 events. */
function protocolEnv(): Record<string, string | undefined> {
  return { ...process.env, KESHA_PROTOCOL: String(PROTOCOL_VERSION) };
}

export function spawnHint(): string {
  return process.env.KESHA_ENGINE_BIN
    ? "KESHA_ENGINE_BIN points at it; fix the path or unset it and run `kesha install`"
    : "run `kesha install`";
}

/** The engine reads only `KESHA_CACHE_DIR`; it gets the root the CLI resolved whenever that differs from the raw value. */
function withResolvedCacheDir(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const cache = resolveStatePaths(env).cacheDir;
  const raw = env.KESHA_CACHE_DIR;
  if (cache.source === "default") {
    if (raw === undefined) return env;
    const { KESHA_CACHE_DIR: _empty, ...rest } = env;
    return rest;
  }
  return raw === cache.path ? env : { ...env, KESHA_CACHE_DIR: cache.path };
}

/** `Bun.spawn` throws synchronously on ENOENT/EACCES; every launch failure becomes `E_ENGINE_SPAWN`. */
function spawnEngineProcess(
  binPath: string,
  args: string[],
  stdio: SpawnStdio,
  env: Record<string, string | undefined> = process.env,
): EngineProcess {
  const interrupted = pendingInterruption();
  if (interrupted) throw interrupted;
  try {
    // `env` is passed explicitly: Bun snapshots process.env at startup otherwise (#874).
    return Bun.spawn([binPath, ...args], { detached: true, stdio, env: withResolvedCacheDir(env) });
  } catch (err) {
    throw new KeshaError("E_ENGINE_SPAWN", `failed to launch kesha-engine at ${binPath}: ${errorMessage(err)}`, {
      hint: spawnHint(),
    });
  }
}

/** An engine that refuses the run before reading closes the pipe; that EPIPE is its answer, reported by the exit status and stderr. */
async function writeEngineStdin(proc: EngineProcess, text: string): Promise<void> {
  const sink = proc.stdin as Bun.FileSink;
  try {
    sink.write(text);
    await sink.end();
  } catch (err) {
    log.debug(`stdin write failed: ${errorMessage(err)}`);
  }
}

export interface EngineProcessOptions<T> {
  /** `[stdin, stdout, stderr]`. A piped stderr is read as protocol 4 events and the engine is told so through its env. */
  stdio: SpawnStdio;
  /** Written to a piped stdin, which is then closed. */
  stdin?: string;
  /** Consumes a piped stdout; `proc` lets a relay stop the engine once nobody reads it. */
  readStdout?: (stream: ReadableStream<Uint8Array>, proc: EngineProcess) => Promise<T>;
  sinks?: EventSinks;
  /** Aborting terminates the process tree, SIGKILL after a grace; an already-aborted signal is `E_INTERRUPTED` before any spawn. */
  signal?: AbortSignal;
}

export interface EngineProcessRun<T> {
  exitCode: number;
  signalCode: string | null;
  /** The signal fired while the engine ran: a caller's cancel, or a deadline it set with `AbortSignal.timeout`. */
  aborted: boolean;
  stdout: T;
  events: StderrOutcome;
}

/** Spawns the engine (or a sidecar) as its own process tree and waits for it; the tree is unregistered however the run ends. */
export async function runEngineProcess<T = undefined>(
  binPath: string,
  args: string[],
  opts: EngineProcessOptions<T>,
): Promise<EngineProcessRun<T>> {
  if (opts.signal?.aborted) throw engineAbortError();
  const startedAt = performance.now();
  log.debug(`spawn ${binPath} ${args.join(" ")}`);
  const eventsOnStderr = opts.stdio[2] === "pipe";
  const proc = spawnEngineProcess(binPath, args, opts.stdio, eventsOnStderr ? protocolEnv() : process.env);
  const tree = registerProcessTree(proc);
  const cancel = abortOnSignal(tree, opts.signal);
  try {
    const [stdout, events, exitCode] = await Promise.all([
      opts.readStdout?.(proc.stdout as ReadableStream<Uint8Array>, proc),
      eventsOnStderr
        ? readEvents(proc.stderr as ReadableStream<Uint8Array>, opts.sinks)
        : { stderr: "", error: null, invalid: [] },
      proc.exited,
      opts.stdin === undefined ? undefined : writeEngineStdin(proc, opts.stdin),
    ]);
    log.debug(`exit=${exitCode} dt=${Math.round(performance.now() - startedAt)}ms args=${JSON.stringify(args)}`);
    return { exitCode, signalCode: proc.signalCode, aborted: cancel.aborted, stdout: stdout as T, events };
  } finally {
    cancel.dispose();
    tree.dispose();
  }
}
