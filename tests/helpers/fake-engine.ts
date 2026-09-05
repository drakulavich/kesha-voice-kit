import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DescribeDocument, FlagSchema, TtsLanguageCapability } from "../../src/engine/describe";

const ENGINE_ENV = ["KESHA_ENGINE_BIN", "KESHA_CACHE_DIR", "HOME", "KESHA_MODEL_MIRROR"] as const;

export interface StagedEngineHome {
  /** The temp directory standing in for `$HOME`. Remove it when the test finishes. */
  dir: string;
  cache: string;
  binDir: string;
  binPath: string;
}

/**
 * Creates a temp `$HOME` holding the engine cache layout and points `HOME`, `KESHA_CACHE_DIR`
 * and `KESHA_ENGINE_BIN` at it. The bin directory exists; no engine is written, so the caller
 * decides whether it is healthy, mute or absent.
 *
 * Restore the environment with `saveEngineEnv()`'s undo, and `rmSync` the returned `dir`.
 */
export function stageEngineHome(prefix: string): StagedEngineHome {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cache = join(dir, ".cache", "kesha");
  const binDir = join(cache, "engine", "bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "kesha-engine");
  process.env.HOME = dir;
  process.env.KESHA_CACHE_DIR = cache;
  process.env.KESHA_ENGINE_BIN = binPath;
  return { dir, cache, binDir, binPath };
}

/** Snapshots the engine-related env so a test can point them at a temp dir and restore afterwards. */
export function saveEngineEnv(): () => void {
  const saved = ENGINE_ENV.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Redirects the whole engine cache into a throwaway dir for one test, and returns the undo.
 *
 * #796: pointing `KESHA_ENGINE_BIN` at a temp path is opt-in per test, so a test that reaches
 * `installEngine` before staging one falls back to `~/.cache/kesha` and overwrites the
 * developer's real engine. Overriding `KESHA_CACHE_DIR` makes that fallback harmless instead
 * of relying on every test to remember.
 */
export function isolateEngineCache(): () => void {
  const restore = saveEngineEnv();
  const dir = mkdtempSync(join(tmpdir(), "kesha-cache-isolated-"));
  process.env.KESHA_CACHE_DIR = dir;
  delete process.env.KESHA_ENGINE_BIN;
  return () => {
    restore();
    rmSync(dir, { recursive: true, force: true });
  };
}

type Row = [command: string, flag: string, schema: FlagSchema];

/** Mirror of `gate_rows()` in `rust/src/protocol/describe.rs`; `describe-template.test.ts` pins it to the released document. */
const DESCRIBE_ROWS: Row[] = [
  ["transcribe", "json", { gate: null }],
  ["transcribe", "vad", { gate: null, conflicts: ["no-vad"] }],
  ["transcribe", "no-vad", { gate: null, conflicts: ["vad"] }],
  ["transcribe", "speakers", { gate: "transcribe.diarize", requires: ["json"], conflicts: ["no-vad"] }],
  ["transcribe", "itn", { gate: "transcribe.itn" }],
  ["record", "out", { gate: null, conflicts: ["live"] }],
  ["record", "live", { gate: "record.live" }],
  ["record", "max-seconds", { gate: null }],
  ["record", "auto-stop", { gate: "record.live.auto-stop", requires: ["live"] }],
  ["record", "auto-stop-silence-ms", { gate: "record.live.auto-stop", requires: ["auto-stop"] }],
  ["record", "auto-stop-threshold", { gate: "record.live.auto-stop", requires: ["auto-stop"] }],
  ["record", "auto-stop-min-speech-ms", { gate: "record.live.auto-stop", requires: ["auto-stop"] }],
  ["install", "no-cache", { gate: null }],
  ["install", "vad", { gate: null }],
  ["install", "no-warmup", { gate: null }],
  ["install", "tts", { gate: "tts", values: "langs" }],
  ["install", "diarize", { gate: "transcribe.diarize" }],
  ["say", "voice", { gate: "tts" }],
  ["say", "lang", { gate: "tts" }],
  ["say", "out", { gate: "tts" }],
  ["say", "rate", { gate: "tts.prosody_rate" }],
  ["say", "list-voices", { gate: "tts" }],
  ["say", "ssml", { gate: "tts" }],
  ["say", "format", { gate: "tts" }],
  ["say", "bitrate", { gate: "tts" }],
  ["say", "sample-rate", { gate: "tts" }],
  ["say", "model", { gate: "tts", requires: ["voice-file"] }],
  ["say", "voice-file", { gate: "tts", requires: ["model"] }],
  ["say", "stdin-loop", { gate: "tts" }],
  ["say", "no-expand-abbrev", { gate: ["tts.ru_acronym_expansion", "tts.en_acronym_expansion"], whenUngated: "drop" }],
];
const FLAGLESS_COMMANDS = ["describe", "detect-lang", "detect-text-lang"];

export interface DescribeOptions {
  backend?: string;
  profile?: string;
  features?: string[];
  tts?: { languages: TtsLanguageCapability[] };
  protocolVersion?: number;
}

export function describeDocument(opts: DescribeOptions = {}): DescribeDocument {
  const features = opts.features ?? ["tts"];
  const ttsBuild = features.includes("tts");
  const diarizeBuild = features.includes("transcribe.diarize");
  const commands: DescribeDocument["commands"] = {};
  for (const name of FLAGLESS_COMMANDS) commands[name] = { flags: {} };
  for (const [command, flag, schema] of DESCRIBE_ROWS) {
    if ((command === "say" || (command === "install" && flag === "tts")) && !ttsBuild) continue;
    if (command === "install" && flag === "diarize" && !diarizeBuild) continue;
    (commands[command] ??= { flags: {} }).flags[flag] = schema;
  }
  const sorted = Object.fromEntries(
    Object.keys(commands)
      .sort()
      .map((name) => [name, { flags: Object.fromEntries(Object.entries(commands[name]!.flags).sort()) }]),
  );
  const doc: DescribeDocument = {
    protocolVersion: opts.protocolVersion ?? 4,
    backend: opts.backend ?? "fake",
    profile: opts.profile ?? "linux",
    features,
    commands: sorted,
  };
  if (opts.tts) doc.tts = opts.tts;
  return doc;
}

export function describeJson(opts: DescribeOptions = {}): string {
  return JSON.stringify(describeDocument(opts));
}

/** Answers `describe` and exits 2 otherwise; `null` writes a mute engine. */
export function writeFakeEngine(binDir: string, features: string[] | null = ["tts"]): string {
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "kesha-engine");
  const body =
    features === null
      ? ""
      : `if [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ backend: "fake-coreml", profile: "darwin", features })}'\n  exit 0\nfi\n`;
  writeFileSync(binPath, `#!/bin/sh\n${body}exit 2\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

export function writeTranscribingEngine(prefix: string, features: string[], transcribeBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "kesha-engine");
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "describe" ]; then
  printf '%s\\n' '${describeJson({ features })}'
  exit 0
fi
if [ "$1" = "transcribe" ]; then
${transcribeBody}
  exit 0
fi
exit 2
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A stub engine that echoes the environment it was handed, for asserting what a spawned
 * child actually inherits (#874).
 *
 * Runs under `bun` instead of a shell script so it executes on Windows too: an
 * extensionless `#!/bin/sh` file is not executable there, which is why the other
 * stub-driven tests in this suite are win32-skipped. Returns the argv pair rather than a
 * path, because the interpreter is the binary and the script is its argument.
 */
export function envEchoEngine(vars: string[]): { binPath: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "kesha-env-echo-"));
  const script = join(dir, "echo-env.js");
  writeFileSync(
    script,
    `for (const v of ${JSON.stringify(vars)}) console.log(v + "=" + (process.env[v] ?? "UNSET"));\n`,
  );
  return { binPath: process.execPath, args: [script] };
}
