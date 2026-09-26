import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MAX_TEXT_CHARS } from "../../src/synth";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";
import { engineVersion } from "../../src/package-info";
import { engineTarget } from "../../src/engine-targets";
import { SUBCOMMAND_NAMES } from "../../src/cli/dispatch";
import { pidIsAlive, stubbornShell, waitForPidExit, waitForPidFile } from "../helpers/process";
import { describeJson, writeTranscribingEngine } from "../helpers/fake-engine";
import {
  DEFAULT_TIMEOUT_MS,
  installFakeDiarizeModel,
  runCliScenario,
  type CliScenarioOptions,
  type CliScenarioResult,
} from "./cli-scenario";

// bun's 5 s per-test default sits below the harness budget, so a scenario dies by
// opaque SIGTERM before it can report what the CLI had managed to do (#805).
setDefaultTimeout(DEFAULT_TIMEOUT_MS * 2);

const tempDirs: string[] = [];
const DEFAULT_CWD = import.meta.dir + "/../..";

async function runCli(
  args: string[],
  opts: CliScenarioOptions = {},
): Promise<CliScenarioResult> {
  return runCliScenario(args, opts);
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isolatedEnv(dir = makeTempDir("kesha-cli-contract-")): {
  HOME: string;
  KESHA_CACHE_DIR: string;
  KESHA_LOG_DIR: string;
  KESHA_STATS_DB: string;
} {
  return {
    HOME: dir,
    KESHA_CACHE_DIR: join(dir, "cache"),
    KESHA_LOG_DIR: join(dir, "logs"),
    KESHA_STATS_DB: join(dir, "stats.sqlite"),
  };
}

function enableDiagnosticLogs(logDir: string): void {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "diagnostic-logs.json"), `${JSON.stringify({ mode: "on" })}\n`);
}

function readDiagnosticLog(logDir: string): { raw: string; events: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(logDir, "kesha.ndjson"), "utf8");
  return {
    raw,
    events: raw.trim().split("\n").map((line) => JSON.parse(line)),
  };
}

function createFakeEngine(dir: string): string {
  const enginePath = join(dir, "kesha-engine");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);

if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: ["transcribe.segments", "transcribe.diarize", "tts"] }))});
  process.exit(0);
}

if (args[0] === "detect-lang") {
  if (process.env.KESHA_FAKE_DETECT_LANG_MARKER) {
    await Bun.write(process.env.KESHA_FAKE_DETECT_LANG_MARKER, "called");
  }
  console.log(JSON.stringify({ code: "ru", confidence: Number(process.env.KESHA_FAKE_DETECT_LANG_CONFIDENCE ?? "0.99") }));
  process.exit(0);
}

if (args[0] === "detect-text-lang") {
  if (process.env.KESHA_FAKE_TEXT_LANG_UNSUPPORTED) {
    console.error("detect-text-lang is only available on macOS");
    process.exit(1);
  }
  console.log(JSON.stringify({ code: "ru", confidence: Number(process.env.KESHA_FAKE_TEXT_LANG_CONFIDENCE ?? "0.98") }));
  process.exit(0);
}

if (args[0] === "transcribe") {
  if (process.env.KESHA_FAKE_TRANSCRIBE_ERROR) {
    const raw = process.env.KESHA_FAKE_TRANSCRIBE_ERROR;
    const coded = raw.match(/^error \\[([A-Z0-9_]+)\\]: ([\\s\\S]*)$/);
    console.error(JSON.stringify({
      kind: "error",
      code: coded ? coded[1] : "E_TRANSCRIBE_FAILED",
      message: coded ? coded[2] : raw,
    }));
    process.exit(42);
  }
  const text = args.includes("--no-vad") ? "Привет без VAD" : "Привет с воркшопа";
  if (args.includes("--speakers")) {
    const end = Number(process.env.KESHA_FAKE_SEGMENT_END || "1.2");
    console.log(JSON.stringify({
      text,
      segments: [{ start: 0, end, text, speaker: 0 }],
    }));
  } else {
    console.log(text);
  }
  process.exit(0);
}

if (args[0] === "say") {
  await Bun.write(Bun.stdout, new Uint8Array(Number(process.env.KESHA_FAKE_SAY_BYTES || "4096")));
  process.exit(0);
}

if (args[0] === "install") {
  if (process.env.KESHA_FAKE_INSTALL_ERROR) {
    console.error(process.env.KESHA_FAKE_INSTALL_ERROR);
    process.exit(42);
  }
  if (process.env.KESHA_FAKE_INSTALL_SILENT_EXIT) {
    process.exit(Number(process.env.KESHA_FAKE_INSTALL_SILENT_EXIT));
  }
  if (process.env.KESHA_FAKE_INSTALL_ARGS_PATH) {
    await Bun.write(process.env.KESHA_FAKE_INSTALL_ARGS_PATH, JSON.stringify(args.slice(1)));
  }
  process.exit(0);
}

console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

/** A `gh` that never answers, shadowing the scenario's fast stub via a PATH override. */
function createWedgedGh(dir: string): string {
  const binDir = join(dir, "wedged-bin");
  mkdirSync(binDir, { recursive: true });
  const staging = join(binDir, "gh.staging");
  writeFileSync(staging, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(staging, 0o755);
  renameSync(staging, join(binDir, "gh"));
  return binDir;
}

function markFakeEngineInstalled(enginePath: string): void {
  writeFileSync(`${enginePath}.version`, `${engineVersion}\n`);
  if (process.platform === "darwin" && process.arch === "arm64") {
    for (const sidecar of ["say-avspeech", "kesha-textlang"]) {
      const path = join(dirname(enginePath), sidecar);
      // Must actually run: install re-downloads a sidecar it cannot spawn (#770).
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
  }
}

function createFailingEngine(dir: string): string {
  const enginePath = join(dir, "kesha-engine-fail-on-use");
  writeFileSync(
    enginePath,
    `#!/usr/bin/env bun
console.error("fake engine should not have been invoked: " + JSON.stringify(Bun.argv.slice(2)));
process.exit(99);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

function createSignalAwareEngine(dir: string, helperPidPath: string): string {
  const enginePath = join(dir, "kesha-engine-signal-aware");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: [] }))});
  process.exit(0);
}
if (args[0] === "transcribe") {
  const child = Bun.spawn(["sh", "-c", ${JSON.stringify(stubbornShell("TERM"))}], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await Bun.write(${JSON.stringify(helperPidPath)}, String(child.pid));
  await new Promise(() => {});
}
if (args[0] === "detect-lang") {
  await Bun.write(${JSON.stringify(helperPidPath)}, String(process.pid));
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

function createSiblingCancellationEngine(dir: string, langPidPath: string): string {
  const enginePath = join(dir, "kesha-engine-sibling-cancel");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: [] }))});
  process.exit(0);
}
if (args[0] === "detect-lang") {
  await Bun.write(${JSON.stringify(langPidPath)}, String(process.pid));
  await new Promise(() => {});
}
if (args[0] === "transcribe") {
  await Bun.sleep(100);
  console.error("transcribe failed quickly");
  process.exit(42);
}
if (args[0] === "detect-text-lang") {
  console.log(JSON.stringify({ code: "en", confidence: 0.95 }));
  process.exit(0);
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

function createHangingTranscribeEngine(dir: string, enginePidPath: string): string {
  const enginePath = join(dir, "kesha-engine-transcribe-hang");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: [] }))});
  process.exit(0);
}
if (args[0] === "transcribe") {
  await Bun.write(${JSON.stringify(enginePidPath)}, String(process.pid));
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

function createSignalIgnoringTranscribeEngine(dir: string, enginePidPath: string): string {
  const enginePath = join(dir, "kesha-engine-transcribe-ignores-signals");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: [] }))});
  process.exit(0);
}
if (args[0] === "transcribe") {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  await Bun.write(${JSON.stringify(enginePidPath)}, String(process.pid));
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

/** Hangs in `transcribe` like `createHangingTranscribeEngine`, but appends a pid line per spawn so a batch can show how many engines it started. */
function createPidLoggingTranscribeEngine(dir: string, enginePidsPath: string): string {
  const enginePath = join(dir, "kesha-engine-transcribe-pid-log");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
import { appendFileSync } from "fs";
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: [] }))});
  process.exit(0);
}
if (args[0] === "transcribe") {
  appendFileSync(${JSON.stringify(enginePidsPath)}, process.pid + "\\n");
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

/** Finishes `transcribe` cleanly on SIGINT, the way a cooperative engine does, so the language-ID spawn that follows is the first thing the signal has to refuse. */
function createFinishOnSignalTranscribeEngine(dir: string, enginePidsPath: string): string {
  const enginePath = join(dir, "kesha-engine-transcribe-finish-on-signal");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
import { appendFileSync } from "fs";
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: [] }))});
  process.exit(0);
}
appendFileSync(${JSON.stringify(enginePidsPath)}, process.pid + "\\n");
if (args[0] === "transcribe") {
  process.on("SIGINT", async () => {
    await Bun.write(Bun.stdout, JSON.stringify({ text: "finished anyway", segments: [] }) + "\\n");
    process.exit(0);
  });
}
await new Promise(() => {});
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

function createHangingRecordEngine(dir: string, enginePidPath: string): string {
  const enginePath = join(dir, "kesha-engine-record-hang");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: [] }))});
  process.exit(0);
}
if (args[0] === "record") {
  await Bun.write(${JSON.stringify(enginePidPath)}, String(process.pid));
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

function createLifecycleEngine(
  dir: string,
  enginePidPath: string,
  hangsDuring: "probe" | "model-install" | "warmup" | "version-check",
): string {
  const enginePath = join(dir, `kesha-engine-${hangsDuring}`);
  // "warmup" reaches the Kokoro warmup only if install's describe-driven gate accepts --tts.
  const capabilities = hangsDuring === "probe"
    ? ""
    : `console.log(${JSON.stringify(describeJson({ backend: "fake", features: hangsDuring === "warmup" ? ["tts"] : [] }))});`;
  const hang = `
  await Bun.write(${JSON.stringify(enginePidPath)}, String(process.pid));
  await new Promise(() => {});
`;
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  ${capabilities}
  process.exit(0);
}
if (args[0] === "--version" && ${JSON.stringify(hangsDuring)} !== "probe" && ${JSON.stringify(hangsDuring)} !== "version-check") {
  console.log("kesha-engine ${engineVersion}");
  process.exit(0);
}
if (
  (${JSON.stringify(hangsDuring)} === "probe" && args[0] === "--version") ||
  (${JSON.stringify(hangsDuring)} === "model-install" && args[0] === "install") ||
  (${JSON.stringify(hangsDuring)} === "warmup" && args[0] === "say") ||
  (${JSON.stringify(hangsDuring)} === "version-check" && args[0] === "--version")
) {${hang}}
if (args[0] === "install") process.exit(0);
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

async function interruptInstallAndReadExit(
  args: readonly string[],
  env: Record<string, string>,
  enginePidPath: string,
): Promise<{ exitCode: number | null; engineStopped: boolean }> {
  const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", ...args], {
    cwd: DEFAULT_CWD,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
  const enginePid = await waitForPidFile(enginePidPath, 800);
  proc.kill("SIGINT");
  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(5_000).then(() => null),
  ]);
  let engineStopped = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!pidIsAlive(enginePid)) {
      engineStopped = true;
      break;
    }
    await Bun.sleep(25);
  }
  if (exitCode === null) proc.kill("SIGKILL");
  if (!engineStopped) process.kill(enginePid, "SIGKILL");
  return { exitCode, engineStopped };
}

function createListVoicesHangEngine(dir: string, enginePidPath: string): string {
  const enginePath = join(dir, "kesha-engine-listvoices-hang");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: ["tts"] }))});
  process.exit(0);
}
if (args[0] === "say" && args[1] === "--list-voices") {
  await Bun.write(${JSON.stringify(enginePidPath)}, String(process.pid));
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Runs the CLI under a real shell so its stdout can be redirected or piped. `runCliScenario`
 * drains stdout to completion, so it can never produce the reader-went-away case #1001 is
 * about; `${PIPESTATUS[0]}` reports the CLI's own status rather than the consumer's.
 */
async function runCliWithShellStdout(
  args: string[],
  stdoutSuffix: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const cli = [process.execPath, "run", "src/cli-entry.ts", ...args].map(shellQuote).join(" ");
  const proc = Bun.spawn(["bash", "-c", `${cli} ${stdoutSuffix}; exit \${PIPESTATUS[0]}`], {
    cwd: DEFAULT_CWD,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr };
}

async function runCliPipedTo(
  args: string[],
  consumer: string,
  opts: { env: Record<string, string>; sinkPath: string },
): Promise<{ exitCode: number; stderr: string; stdoutBytes: number }> {
  const run = await runCliWithShellStdout(
    args,
    `| ${consumer} > ${shellQuote(opts.sinkPath)}`,
    opts.env,
  );
  return {
    ...run,
    stdoutBytes: existsSync(opts.sinkPath) ? statSync(opts.sinkPath).size : 0,
  };
}

function expectContract(
  actual: CliScenarioResult,
  expected: {
    exitCode: number;
    stdoutContains?: string[];
    stdoutNotContains?: string[];
    stderrContains?: string[];
    stderrNotContains?: string[];
    stdoutEmpty?: boolean;
    stderrEmpty?: boolean;
  },
): void {
  expect(actual.exitCode).toBe(expected.exitCode);
  if (expected.stdoutEmpty) expect(actual.stdout).toBe("");
  if (expected.stderrEmpty) expect(actual.stderr).toBe("");
  for (const needle of expected.stdoutContains ?? []) {
    expect(actual.stdout).toContain(needle);
  }
  for (const needle of expected.stdoutNotContains ?? []) {
    expect(actual.stdout).not.toContain(needle);
  }
  for (const needle of expected.stderrContains ?? []) {
    expect(actual.stderr).toContain(needle);
  }
  for (const needle of expected.stderrNotContains ?? []) {
    expect(actual.stderr).not.toContain(needle);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI contracts", () => {
  test("entrypoint help, version, and empty invocation keep stable stream contracts", async () => {
    const help = await runCli(["--help"]);
    expectContract(help, {
      exitCode: 0,
      stdoutContains: ["Kesha Voice Kit", "kesha install", "logs", "--json", "--format"],
      stderrEmpty: true,
    });

    const version = await runCli(["--version"]);
    expectContract(version, { exitCode: 0, stderrEmpty: true });
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
    // The documented short alias must survive the unknown-option gate (Greptile on #1216).
    const short = await runCli(["-v"]);
    expectContract(short, { exitCode: 0, stderrEmpty: true });
    expect(short.stdout).toBe(version.stdout);

    // S1-1: a consumer that asked for JSON must never receive the usage prose on stdout.
    for (const args of [[], ["--json"]]) {
      const empty = await runCli(args);
      expectContract(empty, {
        exitCode: 2,
        stdoutEmpty: true,
        stderrContains: ["error [E_INVALID_ARG]: no input file", "Usage: kesha <audio_file>"],
      });
      // #938 drift guard, at the observable layer: every dispatchable subcommand must
      // surface in the bare-invocation usage the user actually sees. Coupling the loop
      // to SUBCOMMAND_NAMES makes adding a command without listing it fail here; the
      // per-name line anchor (leading whitespace, then `kesha <name>` followed by a
      // space or end of line) stops a shorter name from prefix-matching a longer one.
      for (const name of SUBCOMMAND_NAMES) {
        expect(empty.stderr).toMatch(new RegExp(`^\\s+kesha ${name}( |$)`, "m"));
      }
    }
  });

  test("validation errors are stderr-only and exit with the documented codes", async () => {
    const cases: Array<{
      name: string;
      args: string[];
      exitCode: number;
      stderr: string[];
    }> = [
      {
        name: "json and toon mutex",
        args: ["--json", "--toon", "a.wav"],
        exitCode: 2,
        stderr: ["error [E_INVALID_ARG]: --json and --toon are mutually exclusive"],
      },
      {
        name: "transcript and json mutex",
        args: ["--format", "transcript", "--json", "a.wav"],
        exitCode: 2,
        stderr: ["error [E_INVALID_ARG]: --format transcript is mutually exclusive"],
      },
      {
        name: "timestamps require machine output",
        args: ["--timestamps", "a.wav"],
        exitCode: 2,
        stderr: ["error [E_INVALID_ARG]: --timestamps requires --json"],
      },
      {
        name: "speakers require machine output",
        args: ["--speakers", "a.wav"],
        exitCode: 2,
        stderr: ["error [E_INVALID_ARG]: --speakers requires --json"],
      },
      {
        name: "include-errors requires a structured format",
        args: ["--include-errors", "a.wav"],
        exitCode: 2,
        stderr: ["error [E_INVALID_ARG]: --include-errors requires --json"],
      },
      {
        name: "vad flags are mutually exclusive",
        args: ["--vad", "--no-vad", "a.wav"],
        exitCode: 2,
        stderr: ["error [E_INVALID_ARG]: --vad and --no-vad are mutually exclusive"],
      },
    ];

    for (const entry of cases) {
      const run = await runCli(entry.args, { env: isolatedEnv() });
      expectContract(run, {
        exitCode: entry.exitCode,
        stdoutEmpty: true,
        stderrContains: entry.stderr,
      });
    }
  });

  test("an unknown option is rejected with a coded line and exit 2 before any engine spawn, on transcribe and on subcommands (S9-F3)", async () => {
    const dir = makeTempDir("kesha-cli-contract-unknown-option-");
    const mediaPath = join(dir, "meeting.ogg");
    writeFileSync(mediaPath, "fake media");
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: createFailingEngine(dir) };
    const cases: Array<{ args: string[]; line: string; stderrNotContains?: string[] }> = [
      {
        args: ["--timestamp", mediaPath],
        line: "error [E_INVALID_ARG]: unknown option --timestamp (did you mean --timestamps?)",
      },
      {
        args: [mediaPath, "--speaker", "--json"],
        line: "error [E_INVALID_ARG]: unknown option --speaker (did you mean --speakers?)",
      },
      { args: ["--jsom", mediaPath], line: "error [E_INVALID_ARG]: unknown option --jsom (did you mean --json?)" },
      {
        args: ["--languge", "en", mediaPath],
        line: "error [E_INVALID_ARG]: unknown option --languge",
        stderrNotContains: ["en: error", "File not found"],
      },
      { args: ["--frobnicate", mediaPath], line: "error [E_INVALID_ARG]: unknown option --frobnicate" },
      {
        args: ["say", "--voic", "en-am_michael", "hello"],
        line: "error [E_INVALID_ARG]: unknown option --voic (did you mean --voice?)",
      },
      { args: ["record", "--frobnicate", "--out", join(dir, "x.wav")], line: "error [E_INVALID_ARG]: unknown option --frobnicate" },
    ];
    for (const entry of cases) {
      const run = await runCli(entry.args, { env });
      expectContract(run, {
        exitCode: 2,
        stdoutEmpty: true,
        stderrContains: [entry.line],
        stderrNotContains: ["fake engine should not have been invoked", "Transcribing", ...(entry.stderrNotContains ?? [])],
      });
      expect(run.stderr.split("\n")).toHaveLength(1);
    }
  });

  test("kesha completions without a shell name is a coded usage error on stderr, exit 2, and never writes a partial script to stdout (S10-1)", async () => {
    const missing = await runCli(["completions"]);
    expectContract(missing, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: missing shell (bash, zsh or fish)", "usage: kesha completions <bash|zsh|fish>"],
    });

    const unknown = await runCli(["completions", "powershell"]);
    expectContract(unknown, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: unknown shell 'powershell' (bash, zsh or fish)", "usage: kesha completions <bash|zsh|fish>"],
    });

    const zsh = await runCli(["completions", "zsh"]);
    expectContract(zsh, { exitCode: 0, stderrEmpty: true });
    expect(zsh.stdout).toBe(readFileSync(join(DEFAULT_CWD, "completions", "kesha.zsh"), "utf8").trim());
  });

  test("unknown commands and missing files do not start a configured engine", async () => {
    const dir = makeTempDir("kesha-cli-contract-engine-");
    const enginePath = createFailingEngine(dir);
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    const typo = await runCli(["instal"], { env });
    expectContract(typo, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: ["unknown command 'instal'", "Did you mean install?"],
      stderrNotContains: ["fake engine should not have been invoked"],
    });

    const missing = await runCli(["missing.wav"], { env });
    expectContract(missing, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: ["missing.wav: error [E_INPUT_NOT_FOUND]: File not found"],
      stderrNotContains: ["fake engine should not have been invoked"],
    });

    const transcribeTypo = await runCli(["transcrib"], { env });
    expectContract(transcribeTypo, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: [
        "unknown command 'transcrib'",
        "If this is an audio file, pass a path like './transcrib'.",
        "To transcribe, pass the audio path directly: kesha ./recording.ogg",
      ],
      stderrNotContains: ["fake engine should not have been invoked"],
    });
  });

  test("a directory positional is rejected before any progress output or engine spawn, exit 2 (S9-F1)", async () => {
    const dir = makeTempDir("kesha-cli-contract-engine-");
    const enginePath = createFailingEngine(dir);
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };
    enableDiagnosticLogs(env.KESHA_LOG_DIR);

    const target = makeTempDir("kesha-cli-contract-dir-target-");
    const run = await runCli([target], { env });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: [`${target}: error [E_INVALID_ARG]: is a directory (expected an audio file)`],
      stderrNotContains: ["fake engine should not have been invoked", "Transcribing", "%"],
    });

    const { events } = readDiagnosticLog(env.KESHA_LOG_DIR);
    expect(events.map((event) => event.event)).toEqual(["command.start", "input.invalid", "command.finish"]);
    expect(events[1]).toMatchObject({ command: "transcribe", error_code: "E_INVALID_ARG" });

    const jsonRun = await runCli(["--json", "--include-errors", target], { env });
    expect(jsonRun.exitCode).toBe(2);
    const parsed = JSON.parse(jsonRun.stdout);
    expect(parsed.errors).toEqual([
      { file: target, code: "E_INVALID_ARG", message: "is a directory (expected an audio file)" },
    ]);
  });

  test("transcribe with no engine installed exits 1 with E_ENGINE_SPAWN and the install hint", async () => {
    const dir = makeTempDir("kesha-cli-contract-no-engine-");
    const mediaPath = join(dir, "meeting.ogg");
    writeFileSync(mediaPath, "fake media");
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: join(dir, "absent-kesha-engine") };
    const res = await runCli([mediaPath], { env });
    expectContract(res, {
      exitCode: 1,
      stderrContains: [`${mediaPath}: error [E_ENGINE_SPAWN]: No transcription backend is installed`, "hint: bun add -g @drakulavich/kesha-voice-kit"],
      stderrNotContains: ["Transcribing", "npm i"],
    });
  });

  test("transcribe against a protocol-3 engine exits 1 with E_ENGINE_PROTOCOL pointing at kesha install", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-stale-engine-");
    const enginePath = join(dir, "kesha-engine");
    writeFileSync(enginePath, "#!/bin/sh\necho 'error: unrecognized subcommand describe' >&2\nexit 2\n");
    chmodSync(enginePath, 0o755);
    const mediaPath = join(dir, "meeting.ogg");
    writeFileSync(mediaPath, "fake media");
    const res = await runCli([mediaPath, "--json", "--include-errors"], { env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath } });
    expectContract(res, {
      exitCode: 1,
      stderrContains: ["error [E_ENGINE_PROTOCOL]: ", "hint: run `kesha install`"],
      stderrNotContains: ["Transcribing"],
    });
    const parsed = JSON.parse(res.stdout);
    expect(parsed.errors[0]).toMatchObject({ file: mediaPath, code: "E_ENGINE_PROTOCOL" });
  });

  test("transcribe with a flag the build lacks exits 2 with E_INVALID_ARG before any progress line (S9-F1)", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-flag-gate-");
    const enginePath = join(dir, "kesha-engine");
    writeFileSync(
      enginePath,
      `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["transcribe", "transcribe.segments"] })}'\n  exit 0\nfi\nexit 2\n`,
    );
    chmodSync(enginePath, 0o755);
    const mediaPath = join(dir, "meeting.ogg");
    writeFileSync(mediaPath, "fake media");
    const res = await runCli([mediaPath, "--itn"], { env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath } });
    expectContract(res, {
      exitCode: 2,
      stderrContains: ["error [E_INVALID_ARG]: ", "--itn"],
      stderrNotContains: ["Transcribing"],
    });
  });

  test("a global flag before the subcommand name routes to the subcommand instead of reading it as an input file (S3-F3)", async () => {
    const dir = makeTempDir("kesha-cli-contract-hoist-");
    const outPath = join(dir, "hello.wav");
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: createFailingEngine(dir) };

    const applied = await runCli(["--debug", "record", "--out", outPath, "--max-seconds", "0"], { env });
    expectContract(applied, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: --max-seconds must be an integer between 1 and"],
      stderrNotContains: ["File not found", "record:"],
    });

    const foreign = await runCli(["--json", "record", "--out", outPath], { env });
    expectContract(foreign, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: unknown option --json"],
      stderrNotContains: ["File not found", "record:"],
    });

    const valued = await runCli(["--lang", "en", "record", "--out", outPath], { env });
    expectContract(valued, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: put global flags after the subcommand: kesha record ..."],
      stderrNotContains: ["File not found", "fake engine should not have been invoked"],
    });
    expect(existsSync(outPath)).toBe(false);
  });

  // Exploratory S11-3 / S8-8: --quiet must silence engine progress events like every other progress line; the stub emits one before its transcript.
  function progressEmittingEngineDir(): { dir: string; media: string; env: Record<string, string> } {
    if (process.platform === "win32") throw new Error("posix-only stub");
    const enginePath = writeTranscribingEngine(
      "kesha-cli-quiet-progress-",
      ["transcribe"],
      "  printf '%s\\n' '{\"kind\":\"progress\",\"phase\":\"transcribe\",\"message\":\"loading the model\"}' >&2\n  printf '%s\\n' 'hello world'",
    );
    const dir = dirname(enginePath);
    const media = join(dir, "meeting.ogg");
    writeFileSync(media, "fake media");
    return { dir, media, env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath } };
  }

  test("engine progress events reach stderr on a plain transcribe", async () => {
    if (process.platform === "win32") return;
    const { media, env } = progressEmittingEngineDir();
    const res = await runCli([media], { env });
    expectContract(res, {
      exitCode: 0,
      stdoutContains: ["hello world"],
      stderrContains: ["transcribe: loading the model"],
    });
  });

  test("--quiet silences engine progress events, transcript still returned", async () => {
    if (process.platform === "win32") return;
    const { media, env } = progressEmittingEngineDir();
    const res = await runCli(["--quiet", media], { env });
    expectContract(res, {
      exitCode: 0,
      stdoutContains: ["hello world"],
      stderrNotContains: ["transcribe: loading the model", "Transcribing"],
    });
  });

  test("kesha record without an installed engine fails with an install hint, not a stack trace", async () => {
    const dir = makeTempDir("kesha-cli-contract-record-");
    const outPath = join(dir, "hello.wav");
    const run = await runCli(["record", "--out", outPath], { env: isolatedEnv(dir) });
    expectContract(run, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: ["Error: No recording backend is installed.", "bun add -g @drakulavich/kesha-voice-kit"],
      stderrNotContains: ["at ", "posix_spawn", "ENOENT"],
    });
    expect(existsSync(outPath)).toBe(false);
  });

  test("kesha record with a present but non-executable engine surfaces E_ENGINE_SPAWN, not a stack trace", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-record-eacces-");
    const notExecutable = join(dir, "kesha-engine-not-exec");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    const outPath = join(dir, "hello.wav");
    const run = await runCli(["record", "--out", outPath], {
      env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: notExecutable },
    });
    expectContract(run, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: [`error [E_ENGINE_SPAWN]: failed to launch kesha-engine at ${notExecutable}`],
    });
    expect(run.stderr).not.toMatch(/^\s+at /m);
    expect(existsSync(outPath)).toBe(false);
  });

  test("kesha record --live against a build lacking record.live exits 2 with E_INVALID_ARG", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-record-flag-gate-");
    const enginePath = join(dir, "kesha-engine");
    writeFileSync(
      enginePath,
      `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: [] })}'\n  exit 0\nfi\nexit 2\n`,
    );
    chmodSync(enginePath, 0o755);
    const run = await runCli(["record", "--live"], { env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath } });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: ", "--live"],
    });
  });

  test("kesha record against a stub that exits non-zero with no coded error line still exits 1", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-record-uncoded-fail-");
    const enginePath = join(dir, "kesha-engine");
    writeFileSync(
      enginePath,
      `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: [] })}'\n  exit 0\nfi\nexit 3\n`,
    );
    chmodSync(enginePath, 0o755);
    const outPath = join(dir, "hello.wav");
    const run = await runCli(["record", "--out", outPath], {
      env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
    });
    expectContract(run, {
      exitCode: 1,
      stderrContains: ["kesha-engine record exited with code 3"],
      stderrNotContains: ["error [E_"],
    });
  });

  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`${signal} mid-recording exits ${exitCode} and leaves no engine running`, async () => {
      if (process.platform === "win32") return;
      const dir = makeTempDir(`kesha-cli-contract-record-${signal.toLowerCase()}-exit-`);
      const enginePidPath = join(dir, "engine.pid");
      const enginePath = createHangingRecordEngine(dir, enginePidPath);
      const outPath = join(dir, "hello.wav");

      const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", "record", "--out", outPath], {
        cwd: DEFAULT_CWD,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          ...isolatedEnv(dir),
          KESHA_ENGINE_BIN: enginePath,
        },
      });
      const drained = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const enginePid = await waitForPidFile(enginePidPath);

      proc.kill(signal);

      const [[, stderr], actualExitCode] = await Promise.all([drained, proc.exited]);
      expect(actualExitCode).toBe(exitCode);
      expect(stderr).toBe("");
      expect(await waitForPidExit(enginePid)).toBe(true);
    });
  }

  test("kesha say --list-voices without an installed engine prints the install hint, not a raw ENOENT", async () => {
    const run = await runCli(["say", "--list-voices"], { env: isolatedEnv() });
    expectContract(run, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: ["kesha-engine not installed. run:"],
      stderrNotContains: ["ENOENT", "posix_spawn"],
    });
    expect(run.stderr).not.toMatch(/^\s+at /m);
  });

  test("kesha say --list-voices prints the engine's voice ids on stdout, one per line, and exits 0", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-listvoices-");
    const enginePath = join(dir, "kesha-engine-listvoices");
    writeFileSync(
      enginePath,
      `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ backend: "fake", features: ["tts"] }))});
  process.exit(0);
}
if (args[0] === "say" && args[1] === "--list-voices") {
  console.error(JSON.stringify({ kind: "progress", message: "Loading voices" }));
  console.log("en-am_michael\\nru-vosk-m02\\n");
  process.exit(0);
}
process.exit(99);
`,
    );
    chmodSync(enginePath, 0o755);
    const run = await runCli(["say", "--list-voices"], {
      env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
      trimOutput: false,
    });
    expectContract(run, {
      exitCode: 0,
      stderrContains: ["Loading voices"],
      stderrNotContains: ["kind"],
    });
    expect(run.stdout).toBe("en-am_michael\nru-vosk-m02\n");
  });

  // T1-1: routing handed the text to `detect-text-lang` as an argv element before any length check.
  test("kesha say refuses a NUL byte in the text with one coded line and never spawns the engine", async () => {
    const dir = makeTempDir("kesha-cli-contract-nul-");
    const out = join(dir, "o.wav");
    const run = await runCli(["say", "--out", out], {
      env: isolatedEnv(dir),
      stdin: "null\0byte here",
    });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: text contains a NUL byte"],
      stderrNotContains: ["E_ENGINE_SPAWN", "posix_spawn", "Synthesizing"],
    });
    expect(run.stderr.split("\n")).toHaveLength(1);
    expect(run.stderr).not.toMatch(/^\s+at /m);
    expect(existsSync(out)).toBe(false);
  });

  test("kesha say refuses a 1 MB stdin text as E_TEXT_TOO_LONG, exit 5, with no engine involved", async () => {
    const dir = makeTempDir("kesha-cli-contract-toolong-");
    const chars = 1_048_576;
    const run = await runCli(["say", "--out", join(dir, "big.wav")], {
      env: isolatedEnv(dir),
      stdin: "x".repeat(chars),
    });
    expectContract(run, {
      exitCode: 5,
      stdoutEmpty: true,
      stderrContains: ["error [E_TEXT_TOO_LONG]: text exceeds 5000 chars"],
      stderrNotContains: ["E_ENGINE_SPAWN", "Synthesizing"],
    });
    expect(run.stderr.split("\n")).toHaveLength(1);
  });

  test("kesha say stops reading a stdin pipe once the text limit is passed, without waiting for EOF", async () => {
    const dir = makeTempDir("kesha-cli-contract-openlong-");
    const run = await runCli(["say", "--out", join(dir, "big.wav")], {
      env: isolatedEnv(dir),
      stdin: { openAfter: "x".repeat(MAX_TEXT_CHARS * 4 + 4096) },
      timeoutMs: 10_000,
    });
    expectContract(run, {
      exitCode: 5,
      stdoutEmpty: true,
      stderrContains: ["error [E_TEXT_TOO_LONG]: text exceeds 5000 chars"],
      stderrNotContains: ["E_ENGINE_SPAWN", "Synthesizing"],
    });
  });

  // T1-2: `producer | kesha say "$EMPTY_VAR"` blocked until the producer closed the pipe.
  test("kesha say with an empty positional exits 2 without waiting on an open stdin pipe", async () => {
    const dir = makeTempDir("kesha-cli-contract-emptytext-");
    const out = join(dir, "e.wav");
    const run = await runCli(["say", "", "--out", out], {
      env: isolatedEnv(dir),
      stdin: "open",
      timeoutMs: 10_000,
    });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_TEXT_EMPTY]: text is empty"],
      stderrNotContains: ["Synthesizing"],
    });
    expect(run.elapsedMs).toBeLessThan(5_000);
    expect(existsSync(out)).toBe(false);
  });

  // T1-3: `kesha say hi --out` dropped the flag and sprayed 110 KB of WAV at the terminal, exit 0.
  test("kesha say with a valueless string flag is a coded usage error, exit 2, no audio", async () => {
    const dir = makeTempDir("kesha-cli-contract-novalue-");
    const enginePath = createFailingEngine(dir);
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath };
    for (const flag of ["out", "voice", "lang", "format", "rate", "bitrate", "sample-rate"]) {
      const run = await runCli(["say", "hi", `--${flag}`], { env });
      expectContract(run, {
        exitCode: 2,
        stdoutEmpty: true,
        stderrContains: [`error [E_INVALID_ARG]: --${flag} needs a value`],
        stderrNotContains: ["fake engine should not have been invoked", "Synthesizing"],
      });
      expect(run.stderr.split("\n")).toHaveLength(1);
    }
  });

  // T1-5: the range check lived only in the encoder, so `--bitrate 1` was E_INTERNAL exit 4 after synthesis.
  test("kesha say rejects an out-of-range --bitrate before the engine runs", async () => {
    const dir = makeTempDir("kesha-cli-contract-bitrate-");
    const enginePath = createFailingEngine(dir);
    const run = await runCli(["say", "t", "--format", "ogg-opus", "--bitrate", "1", "--out", join(dir, "z.ogg")], {
      env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
    });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: --bitrate must be between 6000 and 510000 bps."],
      stderrNotContains: ["E_INTERNAL", "fake engine should not have been invoked", "Synthesizing"],
    });
    expect(run.stderr.split("\n")).toHaveLength(1);
  });

  test("kesha say refuses a device --out before the engine runs, and keeps a FIFO working (T1-15)", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-devout-");
    const enginePath = createFailingEngine(dir);
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath };
    for (const path of ["/dev/stdout", "/dev/null"]) {
      const run = await runCli(["say", "t", "--out", path], { env });
      expectContract(run, {
        exitCode: 2,
        stdoutEmpty: true,
        stderrContains: [
          `error [E_INVALID_ARG]: --out ${path} is a character device`,
          "omit --out to write it to stdout",
        ],
        stderrNotContains: ["fake engine should not have been invoked", "Saved", "Synthesizing"],
      });
    }

    const fifo = join(dir, "note.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const accepted = await runCli(["say", "t", "--out", fifo], { env });
    expect(accepted.stderr).not.toContain("character device");
  });

  test("kesha install with a bare language code is the same coded usage error as an unsupported one, exit 2", async () => {
    const dir = makeTempDir("kesha-cli-contract-ttsflag-");
    const run = await runCli(["install", "--plan", "ru"], { env: isolatedEnv(dir) });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: Language codes (ru) require the --tts flag"],
    });
  });

  // T2-11: the refusal was right but uncoded and exited 1, where its sibling catch exits 2.
  test("kesha install --tts with an unsupported language is a coded usage error, exit 2", async () => {
    const dir = makeTempDir("kesha-cli-contract-ttslang-");
    const run = await runCli(["install", "--plan", "--tts", "xx"], { env: isolatedEnv(dir) });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["error [E_INVALID_ARG]: Unsupported TTS language(s): xx.", "Supported on this platform:"],
    });
  });

  test("a batch where every file failed writes nothing to stdout", async () => {
    const run = await runCli(["--json", "a.wav", "b.wav"], {
      env: isolatedEnv(),
    });

    expectContract(run, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: [
        "a.wav: error [E_INPUT_NOT_FOUND]: File not found",
        "b.wav: error [E_INPUT_NOT_FOUND]: File not found",
      ],
    });
  });

  test("--toon takes the same empty-stdout path when every file failed", async () => {
    const run = await runCli(["--toon", "a.wav", "b.wav"], {
      env: isolatedEnv(),
    });

    expectContract(run, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: [
        "a.wav: error [E_INPUT_NOT_FOUND]: File not found",
        "b.wav: error [E_INPUT_NOT_FOUND]: File not found",
      ],
    });
  });

  // trimOutput off: the assertion is a lone "\n" vs nothing, which trimming hides.
  test("human-readable formats leave no stray newline when every file failed", async () => {
    for (const format of [[], ["--verbose"], ["--format", "transcript"]]) {
      const run = await runCli([...format, "a.wav", "b.wav"], {
        env: isolatedEnv(),
        trimOutput: false,
      });
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe("");
    }
  });

  test("--include-errors still reports an all-failed batch structurally", async () => {
    const run = await runCli(["--json", "--include-errors", "a.wav", "b.wav"], {
      env: isolatedEnv(),
    });

    expectContract(run, { exitCode: 1 });
    const parsed = JSON.parse(run.stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.errors).toEqual([
      { file: "a.wav", code: "E_INPUT_NOT_FOUND", message: "File not found" },
      { file: "b.wav", code: "E_INPUT_NOT_FOUND", message: "File not found" },
    ]);
  });

  test("--toon --include-errors reports an all-failed batch structurally (#839)", async () => {
    const run = await runCli(["--toon", "--include-errors", "a.wav", "b.wav"], {
      env: isolatedEnv(),
    });

    expectContract(run, { exitCode: 1 });
    const { decode: decodeToon } = await import("@toon-format/toon");
    expect(decodeToon(run.stdout)).toEqual({
      results: [],
      errors: [
        { file: "a.wav", code: "E_INPUT_NOT_FOUND", message: "File not found" },
        { file: "b.wav", code: "E_INPUT_NOT_FOUND", message: "File not found" },
      ],
    });
  });

  test("--toon --include-errors carries results and errors together on a partial failure (#839)", async () => {
    const dir = makeTempDir("kesha-cli-contract-toon-partial-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    const run = await runCli(["--toon", "--include-errors", mediaPath, "missing.wav"], { env });
    expectContract(run, {
      exitCode: 1,
      stderrContains: ["missing.wav: error [E_INPUT_NOT_FOUND]: File not found"],
      stdoutNotContains: ["Transcribing", "Transcribed"],
    });

    const { decode: decodeToon } = await import("@toon-format/toon");
    const decoded = decodeToon(run.stdout) as {
      results: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    };
    expect(decoded.results).toHaveLength(1);
    expect(decoded.results[0]?.file).toBe(mediaPath);
    expect(decoded.errors).toEqual([
      { file: "missing.wav", code: "E_INPUT_NOT_FOUND", message: "File not found" },
    ]);
  });

  test("--toon --include-errors keeps the envelope when nothing failed (#839)", async () => {
    const dir = makeTempDir("kesha-cli-contract-toon-envelope-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    const run = await runCli(["--toon", "--include-errors", mediaPath], { env });
    expectContract(run, { exitCode: 0 });

    const { decode: decodeToon } = await import("@toon-format/toon");
    const decoded = decodeToon(run.stdout) as {
      results: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    };
    expect(decoded.results).toHaveLength(1);
    expect(decoded.errors).toEqual([]);
  });

  test("a partial failure still prints the results array for the files that succeeded", async () => {
    const dir = makeTempDir("kesha-cli-contract-partial-plain-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    const run = await runCli(["--json", mediaPath, "missing.wav"], { env });
    expectContract(run, {
      exitCode: 1,
      stderrContains: ["missing.wav: error [E_INPUT_NOT_FOUND]: File not found"],
    });

    const parsed = JSON.parse(run.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].file).toBe(mediaPath);
  });

  test("machine-readable partial failures keep parseable JSON on stdout and diagnostics on stderr", async () => {
    const dir = makeTempDir("kesha-cli-contract-partial-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    const run = await runCli(["--json", "--include-errors", mediaPath, "missing.wav"], { env });
    expectContract(run, {
      exitCode: 1,
      stderrContains: [
        `Transcribing ${mediaPath}`,
        "0%",
        `Transcribed ${mediaPath}`,
        "100%",
        "missing.wav: error [E_INPUT_NOT_FOUND]: File not found",
      ],
      stdoutNotContains: ["Transcribing", "Transcribed", "missing.wav: error [E_INPUT_NOT_FOUND]: File not found"],
    });

    const parsed = JSON.parse(run.stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].file).toBe(mediaPath);
    expect(parsed.errors).toEqual([
      { file: "missing.wav", code: "E_INPUT_NOT_FOUND", message: "File not found" },
    ]);
  });

  test("--json --include-errors --speakers reports diarization failures structurally", async () => {
    const dir = makeTempDir("kesha-cli-contract-diarize-error-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const diarizeError =
      "speaker diarization failed\n\nCaused by:\n    kesha-diarize timed out after 600s for 12894s audio; try splitting the file or set KESHA_DIARIZE_TIMEOUT_SECS=1200 (or larger):";
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_TRANSCRIBE_ERROR: diarizeError,
    };
    installFakeDiarizeModel(env.KESHA_CACHE_DIR);

    const run = await runCli(["--json", "--include-errors", "--speakers", mediaPath], { env });

    expectContract(run, {
      exitCode: 1,
      stdoutNotContains: ["Transcribing"],
      stderrContains: [
        `${mediaPath}: error [E_TRANSCRIBE_FAILED]: speaker diarization failed`,
        "kesha-diarize timed out after 600s for 12894s audio",
      ],
    });
    const parsed = JSON.parse(run.stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.errors).toEqual([
      {
        file: mediaPath,
        code: "E_TRANSCRIBE_FAILED",
        message: `error [E_TRANSCRIBE_FAILED]: ${diarizeError}`,
      },
    ]);
  });

  test("--json --include-errors preserves the engine's precise coded error (no collapse)", async () => {
    const dir = makeTempDir("kesha-cli-contract-coded-error-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    // E_DIARIZE_TIMEOUT is retryable — the CLI must not collapse it to E_TRANSCRIBE_FAILED.
    const codedError =
      "error [E_DIARIZE_TIMEOUT]: speaker diarization timed out after 30s for 4s of audio";
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_TRANSCRIBE_ERROR: codedError,
    };
    installFakeDiarizeModel(env.KESHA_CACHE_DIR);

    const run = await runCli(["--json", "--include-errors", "--speakers", mediaPath], { env });

    expectContract(run, {
      exitCode: 1,
      stdoutNotContains: ["Transcribing"],
    });
    const parsed = JSON.parse(run.stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.errors).toEqual([
      {
        file: mediaPath,
        code: "E_DIARIZE_TIMEOUT",
        message: codedError,
      },
    ]);
  });

  test("successful machine-readable output keeps progress off stdout", async () => {
    const dir = makeTempDir("kesha-cli-contract-success-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };
    installFakeDiarizeModel(env.KESHA_CACHE_DIR);

    const json = await runCli([mediaPath, "--json", "--speakers"], { env });
    expectContract(json, {
      exitCode: 0,
      stderrContains: [`Transcribing ${mediaPath}`, "0%", `Transcribed ${mediaPath}`, "100%"],
      stdoutNotContains: ["Transcribing", "Transcribed"],
    });
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      file: mediaPath,
      text: "Привет с воркшопа",
      lang: "ru",
      audioLanguage: { code: "ru", confidence: 0.99 },
      textLanguage: { code: "ru", confidence: 0.98, source: "engine" },
    });
    expect(parsed[0].segments[0]).toEqual({
      start: 0,
      end: 1.2,
      text: "Привет с воркшопа",
      speaker: 0,
    });

    const missingDiarizeEnv: Record<string, string> = {
      ...isolatedEnv(makeTempDir("kesha-cli-contract-missing-diarize-")),
      KESHA_ENGINE_BIN: enginePath,
    };
    const missingDiarize = await runCli([mediaPath, "--json", "--speakers"], { env: missingDiarizeEnv });
    expectContract(missingDiarize, {
      exitCode: 1,
      stderrContains: [
        "error [E_MODEL_MISSING]: ",
        "diarization model not found",
        "hint: run `kesha install --diarize`",
      ],
      stderrNotContains: ["Transcribing", "Transcribed"],
      stdoutNotContains: ["Привет с воркшопа"],
    });

    const transcript = await runCli([mediaPath, "--format", "transcript"], { env });
    expectContract(transcript, {
      exitCode: 0,
      stdoutContains: ["Привет с воркшопа", "[lang: ru, confidence: 0.98]"],
      stdoutNotContains: ["Transcribing", "Transcribed"],
      stderrContains: [`Transcribing ${mediaPath}`, "0%", `Transcribed ${mediaPath}`, "100%"],
    });

    const toon = await runCli([mediaPath, "--toon"], { env });
    expectContract(toon, {
      exitCode: 0,
      stdoutNotContains: ["Transcribing", "Transcribed"],
      stderrContains: [`Transcribing ${mediaPath}`, "0%", `Transcribed ${mediaPath}`, "100%"],
    });
    const { decode: decodeToon } = await import("@toon-format/toon");
    const decoded = decodeToon(toon.stdout) as Array<Record<string, unknown>>;
    expect(decoded[0]?.text).toBe("Привет с воркшопа");
    expect(decoded[0]?.lang).toBe("ru");

    const noVadJson = await runCli([mediaPath, "--json", "--no-vad"], { env });
    expectContract(noVadJson, {
      exitCode: 0,
      stdoutNotContains: ["Transcribing", "Transcribed"],
      stderrContains: [`Transcribing ${mediaPath}`, "0%", `Transcribed ${mediaPath}`, "100%"],
    });
    expect(JSON.parse(noVadJson.stdout)[0].text).toBe("Привет без VAD");
  });

  test("diagnostic logs record successful transcribe events without content", async () => {
    const dir = makeTempDir("kesha-cli-contract-diagnostic-success-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "recording");
    writeFileSync(mediaPath, "fake media");
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };
    enableDiagnosticLogs(env.KESHA_LOG_DIR);

    const run = await runCli(["--json", mediaPath], { env });
    expectContract(run, {
      exitCode: 0,
      stdoutContains: ["Привет с воркшопа"],
      stderrContains: [`Transcribing ${mediaPath}`, `Transcribed ${mediaPath}`],
    });

    const { raw: diagnosticLog, events } = readDiagnosticLog(env.KESHA_LOG_DIR);
    expect(diagnosticLog).not.toContain(mediaPath);
    expect(diagnosticLog).not.toContain("Привет");
    expect(events.map((event) => event.event)).toEqual([
      "command.start",
      "input.audio",
      "engine.exit",
      "command.finish",
    ]);
    expect(events[1]).toMatchObject({
      command: "transcribe",
      format: null,
      sizeBucket: "lt1MB",
    });
    expect(events[2]).toMatchObject({
      command: "transcribe",
      status: "success",
      ranAudioLangId: true,
      ranTxtLangId: true,
    });
  });

  test("diagnostic logs record successful install events without content", async () => {
    const dir = makeTempDir("kesha-cli-contract-install-diagnostic-");
    const enginePath = createFakeEngine(dir);
    markFakeEngineInstalled(enginePath);
    const installArgsPath = join(dir, "install-args.json");
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_INSTALL_ARGS_PATH: installArgsPath,
    };
    enableDiagnosticLogs(env.KESHA_LOG_DIR);

    const run = await runCli(["install", "--vad"], { env });
    expectContract(run, {
      exitCode: 0,
      stdoutContains: ["Engine binary already installed", "Backend installed successfully"],
      stdoutNotContains: [dir],
      stderrContains: ["Installing models..."],
    });
    expect(JSON.parse(readFileSync(installArgsPath, "utf8"))).toEqual(["--vad"]);

    const { raw: diagnosticLog, events } = readDiagnosticLog(env.KESHA_LOG_DIR);
    expect(diagnosticLog).not.toContain(dir);
    expect(diagnosticLog).not.toContain(enginePath);
    expect(events.map((event) => event.event)).toEqual(["command.start", "command.finish"]);
    expect(events[0]).toMatchObject({
      command: "install",
      backend: "auto",
      noCache: false,
      tts: false,
      vad: true,
      diarize: false,
    });
    expect(events[1]).toMatchObject({
      command: "install",
      status: "success",
    });
    expect(typeof events[1]?.durationMs).toBe("number");
  });

  test("install keeps progress on stderr while --plan's deliverable stays on stdout (#945)", async () => {
    const dir = makeTempDir("kesha-cli-contract-install-stdout-purity-");
    const enginePath = createFakeEngine(dir);
    markFakeEngineInstalled(enginePath);
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_INSTALL_ARGS_PATH: join(dir, "install-args.json"),
    };

    // Progress chatter ("Installing models...") is not a result; it must not ride
    // stdout, where a future `install --json` would collide with it.
    const install = await runCli(["install", "--vad"], { env });
    expectContract(install, {
      exitCode: 0,
      stdoutContains: ["Backend installed successfully"],
      stdoutNotContains: ["Installing models..."],
      stderrContains: ["Installing models..."],
    });

    // `--plan` *is* a deliverable and stays on stdout.
    const plan = await runCli(["install", "--plan", "--tts"], { env });
    expectContract(plan, {
      exitCode: 0,
      stdoutContains: ["Kesha install plan"],
    });
  });

  test("install --plan against an engine that never answers describe finishes, warns and reaps the engine", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-mute-engine-");
    const enginePath = join(dir, "kesha-engine");
    const pidFile = join(dir, "engine.pid");
    writeFileSync(enginePath, `#!/bin/sh\necho $$ > "${pidFile}"\nwhile :; do sleep 1; done\n`);
    chmodSync(enginePath, 0o755);
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath };

    const plan = await runCli(["install", "--plan"], { env, timeoutMs: DEFAULT_TIMEOUT_MS + 10_000 });
    const enginePid = await waitForPidFile(pidFile);
    expectContract(plan, {
      exitCode: 0,
      stdoutContains: ["Kesha install plan"],
      stderrContains: [
        `kesha-engine at ${enginePath} did not answer \`describe\` within 15s; continuing without its capabilities — re-run \`kesha install\` to replace it`,
      ],
    });
    expect(await waitForPidExit(enginePid)).toBe(true);
  });

  test("install finishes even when gh on PATH never answers (#810)", async () => {
    const dir = makeTempDir("kesha-cli-contract-wedged-gh-");
    const enginePath = createFakeEngine(dir);
    markFakeEngineInstalled(enginePath);
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      PATH: [createWedgedGh(dir), dirname(process.execPath), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
    };

    // The star probe is the last thing install does, so completing at all — inside
    // the harness budget, against a `gh` that sleeps far past it — is the contract.
    const run = await runCli(["install"], { env });
    expectContract(run, {
      exitCode: 0,
      stdoutContains: ["Backend installed successfully"],
    });
  });

  /**
   * The third failure contract, whose only pin moved to the protocol-violation case above when the
   * prose-writing stub became a violation under protocol 4 (review of #1185). Its record counterpart
   * lives in `recordEngine`; this is install's.
   */
  test("a model install that exits non-zero saying nothing still exits 1, uncoded, like record (#1186)", async () => {
    const dir = makeTempDir("kesha-cli-contract-install-silent-exit-");
    const enginePath = createFakeEngine(dir);
    markFakeEngineInstalled(enginePath);
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_INSTALL_SILENT_EXIT: "3",
    };

    const run = await runCli(["install", "--vad"], { env });
    expectContract(run, {
      exitCode: 1,
      stderrContains: ["Failed to install models: kesha-engine install exited with code 3."],
      stderrNotContains: ["error [E_"],
    });
  });

  test("forcing a backend this platform's release lacks is E_INVALID_ARG, exit 2, before any download, from install, install --plan and init --plan (#1186)", async () => {
    const hostBackend = engineTarget(process.platform, process.arch)?.backend;
    if (!hostBackend) return;
    const other = hostBackend === "coreml" ? "onnx" : "coreml";
    const dir = makeTempDir("kesha-cli-contract-install-backend-");
    // An empty KESHA_ENGINE_BIN counts as unset for the CLI and keeps a developer's own engine out of the pre-check.
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: "" };

    const run = await runCli(["install", `--${other}`], { env });
    expectContract(run, {
      exitCode: 2,
      stderrContains: ["error [E_INVALID_ARG]: ", `Requested backend "${other}" is not available on this platform`],
    });
    const { events } = readDiagnosticLog(env.KESHA_LOG_DIR);
    expect(events[1]).toMatchObject({ command: "install", status: "failed", errorKind: "validation_failed" });

    // init --plan is the declared mirror of that guard (#684): the same refusal, rendered the same way; init's intro on stdout is its own deliverable.
    for (const command of ["install", "init"]) {
      const plan = await runCli([command, "--plan", `--${other}`], { env });
      expectContract(plan, {
        exitCode: 2,
        stdoutNotContains: ["Kesha install plan"],
        stderrContains: ["error [E_INVALID_ARG]: ", `Requested backend "${other}" is not available on this platform`],
      });
    }
  });

  test("diagnostic logs record failed install events without content, and a coded engine failure exits with the engine's status (#1186)", async () => {
    const dir = makeTempDir("kesha-cli-contract-install-diagnostic-failure-");
    const enginePath = createFakeEngine(dir);
    markFakeEngineInstalled(enginePath);
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_INSTALL_ERROR: `fake model install failed in ${dir}`,
    };

    // The stub writes prose, which protocol 4 has no room for: the CLI parses the model-install
    // spawn's stderr as events now, so an off-protocol line is the violation E_INTERNAL names (#1181).
    const run = await runCli(["install", "--vad"], { env });
    expectContract(run, {
      exitCode: 42,
      stdoutContains: ["Engine binary already installed"],
      stderrContains: ["error [E_INTERNAL]: ", "not a protocol event"],
    });

    const { raw: diagnosticLog, events } = readDiagnosticLog(env.KESHA_LOG_DIR);
    expect(diagnosticLog).not.toContain(dir);
    expect(diagnosticLog).not.toContain(enginePath);
    expect(diagnosticLog).not.toContain("fake model install failed");
    expect(events.map((event) => event.event)).toEqual(["command.start", "command.finish"]);
    expect(events[1]).toMatchObject({
      command: "install",
      status: "failed",
      errorKind: "install_failed",
    });
  });

  test("long speaker transcripts skip whole-file audio language detection", async () => {
    const dir = makeTempDir("kesha-cli-contract-long-speakers-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "meeting.mp4");
    const detectLangMarker = join(dir, "detect-lang-called");
    writeFileSync(mediaPath, "fake media");
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_DETECT_LANG_MARKER: detectLangMarker,
      KESHA_FAKE_SEGMENT_END: "900",
      KESHA_DEBUG: "1",
    };
    installFakeDiarizeModel(env.KESHA_CACHE_DIR);

    const run = await runCli(["--json", "--speakers", mediaPath], { env });

    expectContract(run, {
      exitCode: 0,
      stdoutNotContains: ["audioLanguage"],
      stderrContains: ["skip lang_id_audio"],
    });
    const parsed = JSON.parse(run.stdout);
    expect(parsed[0].audioLanguage).toBeUndefined();
    expect(parsed[0].textLanguage).toEqual({ code: "ru", confidence: 0.98, source: "engine" });
    expect(parsed[0].segments[0].end).toBe(900);
    expect(existsSync(detectLangMarker)).toBe(false);
  });

  test("textLanguage names the detector that produced it (#941)", async () => {
    const dir = makeTempDir("kesha-cli-contract-textlang-source-");
    const enginePath = createFakeEngine(dir);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath };

    const fromEngine = await runCli(["--json", mediaPath], { env });
    expectContract(fromEngine, { exitCode: 0 });
    expect(JSON.parse(fromEngine.stdout)[0].textLanguage).toEqual({
      code: "ru",
      confidence: 0.98,
      source: "engine",
    });

    const fallbackDir = makeTempDir("kesha-cli-contract-textlang-fallback-");
    const fallbackMedia = join(fallbackDir, "workshop.mp4");
    writeFileSync(fallbackMedia, "fake media");
    const fromTinyld = await runCli(["--json", fallbackMedia], {
      env: {
        ...isolatedEnv(fallbackDir),
        KESHA_ENGINE_BIN: enginePath,
        KESHA_FAKE_TEXT_LANG_UNSUPPORTED: "1",
      },
    });
    expectContract(fromTinyld, { exitCode: 0 });
    // The scale gap `source` exists to disambiguate: tinyld scores this exact
    // transcript at 0.2 where the engine reports 0.98, so a consumer thresholding
    // at 0.5 would discard every correct non-macOS detection.
    expect(JSON.parse(fromTinyld.stdout)[0].textLanguage).toEqual({
      code: "ru",
      confidence: 0.2,
      source: "tinyld",
    });

    const unsureDir = makeTempDir("kesha-cli-contract-textlang-unsure-");
    const unsureMedia = join(unsureDir, "workshop.mp4");
    writeFileSync(unsureMedia, "fake media");
    const fromUnsureEngine = await runCli(["--json", unsureMedia], {
      env: {
        ...isolatedEnv(unsureDir),
        KESHA_ENGINE_BIN: enginePath,
        KESHA_FAKE_TEXT_LANG_CONFIDENCE: "0",
      },
    });
    expectContract(fromUnsureEngine, { exitCode: 0 });
    // The case that caused #941: a genuinely unsure engine still reads as the
    // engine, so 0 no longer doubles as "this came from the fallback".
    expect(JSON.parse(fromUnsureEngine.stdout)[0].textLanguage).toEqual({
      code: "ru",
      confidence: 0,
      source: "engine",
    });
  });

  test("Ctrl+C terminates helper processes below the engine", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-sigint-");
    const helperPidPath = join(dir, "helper.pid");
    const enginePath = createSignalAwareEngine(dir, helperPidPath);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");

    const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", mediaPath], {
      cwd: DEFAULT_CWD,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...isolatedEnv(dir),
        KESHA_ENGINE_BIN: enginePath,
      },
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const helperPid = await waitForPidFile(helperPidPath);

    proc.kill("SIGINT");

    const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
    expect(exitCode).toBe(130);
    expect(stdout).not.toContain("fake media");
    expect(stderr).toContain(`Transcribing ${mediaPath}`);
    expect(await waitForPidExit(helperPid)).toBe(true);
  });

  test("Ctrl+C during say --list-voices terminates the engine and exits 130", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-listvoices-sigint-");
    const enginePidPath = join(dir, "engine.pid");
    const enginePath = createListVoicesHangEngine(dir, enginePidPath);

    const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", "say", "--list-voices"], {
      cwd: DEFAULT_CWD,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...isolatedEnv(dir),
        KESHA_ENGINE_BIN: enginePath,
      },
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const enginePid = await waitForPidFile(enginePidPath);

    proc.kill("SIGINT");

    const [, , exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
    expect(exitCode).toBe(130);
    expect(await waitForPidExit(enginePid)).toBe(true);
  });

  // The interrupted file counts as a failure, so the signal's code has to beat the batch's
  // own exit(1) (src/cli/main.ts) for these to hold — that ordering is what they measure.
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    test(`${signal} mid-transcription exits ${exitCode} and leaves no engine running`, async () => {
      if (process.platform === "win32") return;
      const dir = makeTempDir(`kesha-cli-contract-${signal.toLowerCase()}-exit-`);
      const enginePidPath = join(dir, "engine.pid");
      const enginePath = createHangingTranscribeEngine(dir, enginePidPath);
      const mediaPath = join(dir, "meeting.ogg");
      writeFileSync(mediaPath, "fake media");

      const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", mediaPath], {
        cwd: DEFAULT_CWD,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          ...isolatedEnv(dir),
          KESHA_ENGINE_BIN: enginePath,
        },
      });
      const drained = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const enginePid = await waitForPidFile(enginePidPath);

      proc.kill(signal);

      const [[, stderr], actualExitCode] = await Promise.all([drained, proc.exited]);
      expect(actualExitCode).toBe(exitCode);
      expect(stderr).toContain(`${mediaPath}: error [E_INTERRUPTED]: interrupted (${signal})`);
      expect(stderr).not.toContain("E_INTERNAL");
      expect(await waitForPidExit(enginePid)).toBe(true);
    });
  }

  test("Ctrl+C mid-batch starts no further file, reports the rest as interrupted, and exits once the engine is gone", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-batch-sigint-");
    const enginePidsPath = join(dir, "engine.pids");
    const enginePath = createPidLoggingTranscribeEngine(dir, enginePidsPath);
    const files = ["a.ogg", "b.ogg", "c.ogg"].map((name) => join(dir, name));
    for (const file of files) writeFileSync(file, "fake media");

    const proc = Bun.spawn(
      [process.execPath, "run", "src/cli-entry.ts", "--json", "--include-errors", ...files],
      {
        cwd: DEFAULT_CWD,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          ...isolatedEnv(dir),
          KESHA_ENGINE_BIN: enginePath,
        },
      },
    );
    const drained = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const enginePid = await waitForPidFile(enginePidsPath);

    const signalledAt = performance.now();
    proc.kill("SIGINT");

    const [[stdout, stderr], exitCode] = await Promise.all([drained, proc.exited]);
    const exitedAfterMs = performance.now() - signalledAt;
    expect(exitCode).toBe(130);
    expect(await waitForPidExit(enginePid)).toBe(true);
    expect(stderr).toContain(`Transcribing ${files[0]}`);
    expect(stderr).not.toContain(`Transcribing ${files[1]}`);
    for (const file of files) expect(stderr).toContain(`${file}: error [E_INTERRUPTED]: interrupted (SIGINT)`);
    expect(readFileSync(enginePidsPath, "utf8").trim().split("\n")).toHaveLength(1);
    const envelope = JSON.parse(stdout) as { results: unknown[]; errors: { file: string; code: string }[] };
    expect(envelope.results).toEqual([]);
    expect(envelope.errors.map((e) => [e.file, e.code])).toEqual(files.map((file) => [file, "E_INTERRUPTED"]));
    // The stub dies on the first SIGINT; before the fix the CLI always sat out the full force-kill grace (1 000 ms + 50 ms).
    expect(exitedAfterMs).toBeLessThan(1_000);
  });

  test("no engine spawns after Ctrl+C, even for a file whose transcription finished under the signal", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-no-spawn-after-sigint-");
    const enginePidsPath = join(dir, "engine.pids");
    const enginePath = createFinishOnSignalTranscribeEngine(dir, enginePidsPath);
    const mediaPath = join(dir, "meeting.ogg");
    writeFileSync(mediaPath, "fake media");

    const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", "--json", "--include-errors", mediaPath], {
      cwd: DEFAULT_CWD,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...isolatedEnv(dir),
        KESHA_ENGINE_BIN: enginePath,
      },
    });
    const drained = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const enginePid = await waitForPidFile(enginePidsPath);

    proc.kill("SIGINT");

    const [[stdout, stderr], exitCode] = await Promise.all([drained, proc.exited]);
    expect(exitCode).toBe(130);
    expect(await waitForPidExit(enginePid)).toBe(true);
    expect(stderr).toContain(`${mediaPath}: error [E_INTERRUPTED]: interrupted (SIGINT)`);
    expect(readFileSync(enginePidsPath, "utf8").trim().split("\n")).toHaveLength(1);
    const envelope = JSON.parse(stdout) as { errors: { code: string }[] };
    expect(envelope.errors.map((e) => e.code)).toEqual(["E_INTERRUPTED"]);
  });

  test("an engine that ignores the forwarded signal is force-killed, and the report still names the signal Ctrl+C sent", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-sigkill-escalation-");
    const enginePidPath = join(dir, "engine.pid");
    const enginePath = createSignalIgnoringTranscribeEngine(dir, enginePidPath);
    const mediaPath = join(dir, "meeting.ogg");
    writeFileSync(mediaPath, "fake media");

    const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", mediaPath], {
      cwd: DEFAULT_CWD,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...isolatedEnv(dir),
        KESHA_ENGINE_BIN: enginePath,
      },
    });
    const drained = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const enginePid = await waitForPidFile(enginePidPath);

    proc.kill("SIGINT");

    const [[, stderr], exitCode] = await Promise.all([drained, proc.exited]);
    expect(exitCode).toBe(130);
    expect(stderr).toContain(`${mediaPath}: error [E_INTERRUPTED]: interrupted (SIGINT)`);
    expect(stderr).not.toContain("137");
    expect(stderr).not.toContain("SIGKILL");
    expect(await waitForPidExit(enginePid)).toBe(true);
  });

  for (const [phase, args] of [
    ["probe", ["install"]],
    ["model-install", ["install"]],
    ["version-check", ["install"]],
  ] as const) {
    test(`Ctrl+C during ${phase} terminates the engine and exits 130 (#971)`, async () => {
      if (process.platform === "win32") return;
      const dir = makeTempDir(`kesha-cli-contract-${phase}-signal-`);
      const enginePidPath = join(dir, "engine.pid");
      const enginePath = createLifecycleEngine(dir, enginePidPath, phase);
      markFakeEngineInstalled(enginePath);

      const result = await interruptInstallAndReadExit(
        args,
        { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
        enginePidPath,
      );

      expect(result.exitCode).toBe(130);
      expect(result.engineStopped).toBe(true);
    });
  }

  test("Ctrl+C during the darwin Kokoro warmup terminates the engine and exits 130 (#971)", async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    const dir = makeTempDir("kesha-cli-contract-warmup-signal-");
    const enginePidPath = join(dir, "engine.pid");
    const enginePath = createLifecycleEngine(dir, enginePidPath, "warmup");
    markFakeEngineInstalled(enginePath);

    const result = await interruptInstallAndReadExit(
      ["install", "--tts", "en"],
      { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
      enginePidPath,
    );

    expect(result.exitCode).toBe(130);
    expect(result.engineStopped).toBe(true);
  });

  test("early transcription failure does not start audio language detection", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-sibling-cancel-");
    const langPidPath = join(dir, "lang.pid");
    const enginePath = createSiblingCancellationEngine(dir, langPidPath);
    const mediaPath = join(dir, "workshop.mp4");
    writeFileSync(mediaPath, "fake media");
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    const run = await runCli(["--json", mediaPath], { env });

    expectContract(run, {
      exitCode: 1,
      stdoutEmpty: true,
      stderrContains: ["transcribe failed quickly"],
    });
    expect(existsSync(langPidPath)).toBe(false);
  });

  // Two cold TS-transpile spawns; wide budget needed under CPU contention.
  test("diagnostic and support commands return parseable/readable contracts without leaking temp home", async () => {
    const dir = makeTempDir("kesha-cli-contract-diagnostics-");
    const enginePath = createFakeEngine(dir);
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    const doctor = await runCli(["doctor", "--json", "--redact"], { env, timeoutMs: 15_000 });
    expectContract(doctor, {
      exitCode: 0,
      stderrEmpty: true,
      stdoutNotContains: [dir],
    });
    const report = JSON.parse(doctor.stdout);
    expect(report.redacted).toBe(true);
    expect(report.package.name).toBe("@drakulavich/kesha-voice-kit");
    expect(report.engine.path).toBe("~/kesha-engine");
    expect(report.engine.capabilities.backend).toBe("fake");
    expect(report.env.KESHA_ENGINE_BIN).toBe("~/kesha-engine");
    expect(report.env.KESHA_STATS_DB).toBe("~/stats.sqlite");
    expect(report.diagnosticLogs.activePath).toBe("~/logs/kesha.ndjson");
    expect(report.diagnosticLogs.mode).toBe("retain-on-failure");

    const bundlePath = join(dir, "bundle.tar.gz");
    const bundle = await runCli(["support-bundle", "--output", bundlePath], {
      env,
      timeoutMs: 15_000,
      artifacts: [bundlePath],
    });
    // The report is prose, so it stays off stdout for a `> log` caller (Exploratory S5-F4).
    expectContract(bundle, {
      exitCode: 0,
      stdoutEmpty: true,
      stderrContains: [`Created support bundle: ${bundlePath}`, "Entries: 4", "Size:"],
    });
    expect(existsSync(bundlePath)).toBe(true);
    expect(bundle.artifacts[0]).toMatchObject({
      path: bundlePath,
      exists: true,
    });
    expect(bundle.artifacts[0]?.sizeBytes).toBeGreaterThan(0);
  }, 30_000);

  test("read-only planning and stats commands keep user data on stdout", async () => {
    const dir = makeTempDir("kesha-cli-contract-readonly-");
    const enginePath = createFailingEngine(dir);
    const env = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
    };

    // Run read-only commands concurrently — they don't mutate state and the
    // parallelism keeps this spawn-heavy test under budget on a loaded runner.
    const [plan, initPlan, status, logsStatus, logsStatusJson, logsEnableJson] = await Promise.all([
      runCli(["install", "--plan", "--tts"], { env }),
      runCli(["init", "--plan", "--tts", "--vad"], { env }),
      runCli(["stats", "status"], { env }),
      runCli(["logs", "status"], { env }),
      runCli(["logs", "status", "--json"], { env }),
      runCli(["logs", "enable", "--json"], { env }),
    ]);

    expect(plan.envDiff.overrides.KESHA_ENGINE_BIN).toBe(enginePath);
    expectContract(plan, {
      exitCode: 0,
      stdoutContains: [
        "Kesha install plan",
        "Expected Kesha-managed network for this run:",
        "Run: kesha install --tts en",
      ],
      stderrNotContains: ["fake engine should not have been invoked"],
    });

    expectContract(initPlan, {
      exitCode: 0,
      stdoutContains: [
        "Kesha init",
        "Nothing downloads until you confirm",
        "Kesha install plan",
        "Run: kesha install --tts en --vad",
      ],
      stderrNotContains: ["fake engine should not have been invoked"],
    });

    expectContract(status, {
      exitCode: 0,
      stdoutContains: [`Database: ${env.KESHA_STATS_DB}`, "Runs: 0", "Retention: 90 day(s)"],
      stderrEmpty: true,
    });

    expectContract(logsStatus, {
      exitCode: 0,
      stdoutContains: [
        "Kesha diagnostic logs: enabled",
        "Mode: retain-on-failure",
        `Path: ${join(env.KESHA_LOG_DIR, "kesha.ndjson")}`,
        "Rotated files: 0",
      ],
      stderrEmpty: true,
    });

    expectContract(logsStatusJson, {
      exitCode: 0,
      stderrEmpty: true,
    });
    const logsStatusReport = JSON.parse(logsStatusJson.stdout);
    expect(logsStatusReport).toMatchObject({
      dir: env.KESHA_LOG_DIR,
      activePath: join(env.KESHA_LOG_DIR, "kesha.ndjson"),
      statePath: join(env.KESHA_LOG_DIR, "diagnostic-logs.json"),
      exists: false,
      activeSizeBytes: 0,
      rotatedFiles: [],
      totalSizeBytes: 0,
      mode: "retain-on-failure",
      maxBytes: 10 * 1024 * 1024,
      retain: 5,
    });

    expectContract(logsEnableJson, {
      exitCode: 2,
      stdoutEmpty: true,
    });

    const logsEnable = await runCli(["logs", "enable"], { env });
    expectContract(logsEnable, {
      exitCode: 0,
      stdoutContains: [`Path: ${join(env.KESHA_LOG_DIR, "kesha.ndjson")}`],
      stderrEmpty: true,
    });

    const logsMode = await runCli(["logs", "mode", "retain-on-failure"], { env });
    expectContract(logsMode, {
      exitCode: 0,
      stderrEmpty: true,
    });

    const logsReset = await runCli(["logs", "reset"], { env });
    expectContract(logsReset, {
      exitCode: 0,
      stderrEmpty: true,
    });

    const enabled = await runCli(["stats", "enable"], { env });
    expectContract(enabled, {
      exitCode: 0,
      stdoutContains: [`Database: ${env.KESHA_STATS_DB}`],
      stderrEmpty: true,
    });

    const missing = await runCli(["private-recording.wav"], { env });
    expect(missing.exitCode).toBe(1);
    const { raw: diagnosticLog, events: diagnosticEvents } = readDiagnosticLog(env.KESHA_LOG_DIR);
    expect(diagnosticLog).not.toContain("private-recording.wav");
    expect(diagnosticEvents.map((event) => event.event)).toEqual([
      "command.start",
      "input.missing",
      "command.finish",
    ]);
    expect(diagnosticEvents[0]).toMatchObject({
      command: "transcribe",
      itemCount: 1,
      outputFormat: "text",
    });
    expect(diagnosticEvents[2]).toMatchObject({
      command: "transcribe",
      status: "failed",
      errorCount: 1,
    });

    const week = await runCli(["stats", "week"], { env });
    expectContract(week, {
      exitCode: 0,
      stdoutContains: ["Kesha Stats", "Runs: 1", "Bottlenecks:", "Slowest anonymous runs:"],
      stderrEmpty: true,
    });

    const errors = await runCli(["stats", "errors"], { env });
    expectContract(errors, {
      exitCode: 0,
      stdoutContains: ["E_INPUT_NOT_FOUND"],
      stdoutNotContains: ["private-recording.wav"],
      stderrEmpty: true,
    });

    const jsonExport = await runCli(["stats", "export", "--format", "json"], { env });
    expectContract(jsonExport, {
      exitCode: 0,
      stdoutContains: ['"contentFree": true', '"runs"', '"errors"'],
      stdoutNotContains: ["private-recording.wav"],
      stderrEmpty: true,
    });

    const csvExport = await runCli(["stats", "export", "--format", "csv"], { env });
    expectContract(csvExport, {
      exitCode: 0,
      stdoutContains: ["table,id,run_id", "runs,", "errors,"],
      stdoutNotContains: ["private-recording.wav"],
      stderrEmpty: true,
    });

    const retention = await runCli(["stats", "retention", "30"], { env });
    expectContract(retention, {
      exitCode: 0,
      stdoutContains: ["Kesha Stats retention set to 30 day(s)"],
      stderrEmpty: true,
    });

    const vacuum = await runCli(["stats", "vacuum"], { env });
    expectContract(vacuum, {
      exitCode: 0,
      stdoutContains: [`Database: ${env.KESHA_STATS_DB}`],
      stderrEmpty: true,
    });

    const reset = await runCli(["stats", "reset"], { env });
    expectContract(reset, {
      exitCode: 0,
      stdoutContains: ["run(s)"],
      stderrEmpty: true,
    });
    // ~20 sequential spawns; 30s needed alongside model-download e2e tests.
  }, 30000);

  test("stats export without a format exits 2 with the usage line and no payload (Exploratory S5-F2)", async () => {
    const env = isolatedEnv();
    const run = await runCli(["stats", "export"], { env });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["usage: kesha stats export --format json|csv"],
    });
  });

  test("stats retention with a negative day count exits 2 instead of eating it as a flag (Exploratory S5-F3)", async () => {
    const env = isolatedEnv();
    const run = await runCli(["stats", "retention", "-5"], { env });
    expectContract(run, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["usage: kesha stats retention <days|off>"],
    });
  });

  test("--plan previews the overridden engine version and downloads nothing (#738)", async () => {
    const dir = makeTempDir("kesha-cli-contract-engine-version-");
    const enginePath = createFailingEngine(dir);
    const env: Record<string, string> = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath };

    const [plan, invalid, initPlan] = await Promise.all([
      runCli(["install", "--plan", "--engine-version", "9.9.9-alpha.1", "--tts"], { env }),
      runCli(["install", "--plan", "--engine-version", "latest"], { env }),
      runCli(["init", "--plan"], { env }),
    ]);

    expectContract(plan, {
      exitCode: 0,
      stdoutContains: [
        "Engine release: v9.9.9-alpha.1 (overrides the pinned",
        "GitHub release v9.9.9-alpha.1",
        "Run: kesha install --engine-version 9.9.9-alpha.1 --tts en",
      ],
      stdoutNotContains: [`GitHub release v${engineVersion}`],
      stderrNotContains: ["fake engine should not have been invoked"],
    });

    expectContract(invalid, {
      exitCode: 2,
      stdoutEmpty: true,
      stderrContains: ["--engine-version needs an exact SemVer 2.0 version"],
    });

    // `init` is the guided path; an override is an expert action and stays off it (#738).
    expectContract(initPlan, {
      exitCode: 0,
      stdoutContains: [`Engine release: v${engineVersion}`],
      stdoutNotContains: ["--engine-version"],
    });

    expect(existsSync(join(dir, "cache", "engine"))).toBe(false);
  }, 30000);

  // `kesha say | ffplay -` then quitting, or `| head -c N` for a preview, is ordinary use of
  // a filter. Bun delivers the resulting EPIPE asynchronously, so it used to escape as an
  // uncaught crash dump — absolute install paths, a Bun banner, exit 1 on a synthesis that
  // in fact succeeded (#1001).
  test("a reader that stops reading ends the run quietly, on say and on transcribe (#1001)", async () => {
    const dir = makeTempDir("kesha-cli-contract-stdout-epipe-");
    const enginePath = createFakeEngine(dir);
    markFakeEngineInstalled(enginePath);
    const mediaPath = join(dir, "clip.ogg");
    writeFileSync(mediaPath, "fake media");
    const env: Record<string, string> = {
      ...isolatedEnv(dir),
      KESHA_ENGINE_BIN: enginePath,
      KESHA_FAKE_SAY_BYTES: "262144",
    };

    const dropped = await runCliPipedTo(["say", "--voice", "en-am_michael", "тест потока"], "true", {
      env,
      sinkPath: join(dir, "dropped.bin"),
    });
    expect(dropped.stderr).toBe("");
    expect(dropped.exitCode).toBe(0);
    expect(dropped.stdoutBytes).toBe(0);

    const preview = await runCliPipedTo(
      ["say", "--voice", "en-am_michael", "тест потока"],
      "head -c 1000",
      { env, sinkPath: join(dir, "preview.bin") },
    );
    expect(preview.stderr).toBe("");
    expect(preview.exitCode).toBe(0);
    expect(preview.stdoutBytes).toBe(1000);

    // Same write path, so the guard belongs to stdout rather than to `say` (main.ts:399-407).
    const transcript = await runCliPipedTo([mediaPath], "true", {
      env,
      sinkPath: join(dir, "transcript.txt"),
    });
    expect(transcript.stderr).not.toContain("EPIPE");
    expect(transcript.exitCode).toBe(0);
  }, 30000);

  test("kesha record --live stops recording when its reader leaves, instead of holding the microphone (#1187)", async () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir("kesha-cli-contract-record-reader-left-");
    const enginePath = join(dir, "kesha-engine");
    const finishedMarker = join(dir, "finished-naturally");
    // Ten transcript lines over three seconds; the marker means nobody stopped the engine.
    writeFileSync(
      enginePath,
      `#!/bin/sh
if [ "$1" = "describe" ]; then printf '%s\\n' '${describeJson({ features: ["record.live"] })}'; exit 0; fi
trap 'exit 143' TERM INT
i=0
while [ $i -lt 10 ]; do i=$((i+1)); echo "transcript line $i"; sleep 0.3; done
: > ${shellQuote(finishedMarker)}
exit 0
`,
    );
    chmodSync(enginePath, 0o755);
    const env: Record<string, string> = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath };

    const run = await runCliPipedTo(["record", "--live"], "head -1", { env, sinkPath: join(dir, "first.txt") });

    expect(run.stderr).not.toContain("EPIPE");
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(dir, "first.txt"), "utf8")).toBe("transcript line 1\n");
    expect(existsSync(finishedMarker)).toBe(false);
  }, 30000);

  test("a stdout that fails for any other reason still fails loudly (#1001)", async () => {
    const dir = makeTempDir("kesha-cli-contract-stdout-ebadf-");
    const enginePath = createFakeEngine(dir);
    markFakeEngineInstalled(enginePath);
    const env: Record<string, string> = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath };

    // fd 1 opened read-only: every write fails EBADF. Not a reader leaving, so the run has to
    // say what went wrong and exit non-zero rather than pretend the audio was delivered.
    const run = await runCliWithShellStdout(
      ["say", "--voice", "en-am_michael", "тест потока"],
      "1</dev/null",
      env,
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("failed writing to stdout");
    expect(run.stderr).toContain("EBADF");
    expect(run.stderr).not.toContain("at writeFast");
  }, 30000);

  describe("language flags", () => {
    /** Exploratory S1-3: quiet drops progress, not warnings; the mismatch used to ride on the progress bar and vanish with it. */
    test("--quiet keeps the language-mismatch warning on stderr", async () => {
      const dir = makeTempDir("kesha-cli-contract-quiet-lang-warn-");
      const enginePath = createFakeEngine(dir);
      const mediaPath = join(dir, "workshop.mp4");
      writeFileSync(mediaPath, "fake media");

      const run = await runCli(["-q", "--lang", "en", mediaPath], {
        env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
      });
      expectContract(run, {
        exitCode: 0,
        stderrContains: [`${mediaPath}: warning: expected language "en" but detected "ru"`],
        stderrNotContains: ["Transcribing", "Transcribed"],
      });
      expect(run.stdout).not.toBe("");
    });

    /**
     * Exploratory S11-2 and S11-4: without the text-lang sidecar, tinyld's top guess named `lang` at any
     * score, 0.2 included, and silence's audio prior (nn at 0.27) was published like a real detection.
     */
    test("weak text and audio guesses stay in their raw fields but do not name lang", async () => {
      const dir = makeTempDir("kesha-cli-contract-lang-floor-");
      const enginePath = createFakeEngine(dir);
      const mediaPath = join(dir, "workshop.mp4");
      writeFileSync(mediaPath, "fake media");
      const env = {
        ...isolatedEnv(dir),
        KESHA_ENGINE_BIN: enginePath,
        KESHA_FAKE_TEXT_LANG_UNSUPPORTED: "1",
        KESHA_FAKE_DETECT_LANG_CONFIDENCE: "0.267",
      };

      const run = await runCli(["--json", "--verbose", mediaPath], { env });
      expectContract(run, {
        exitCode: 0,
        stderrContains: [
          "Audio language: ru (confidence: 0.27, below the 0.5 floor, ignored for lang)",
          "Text language: ru (confidence: 0.20, below the 0.5 floor, ignored for lang)",
        ],
      });
      const [parsed] = JSON.parse(run.stdout);
      expect(parsed.audioLanguage).toEqual({ code: "ru", confidence: 0.267 });
      expect(parsed.textLanguage).toEqual({ code: "ru", confidence: 0.2, source: "tinyld" });
      expect(parsed.lang).toBe("");
    });

    /** Exploratory S11-4: confident audio is the fallback when the text guess was too weak, and it warns once, not twice. */
    test("confident audio names lang when tinyld could not, with a single mismatch warning", async () => {
      const dir = makeTempDir("kesha-cli-contract-audio-fallback-");
      const enginePath = createFakeEngine(dir);
      const mediaPath = join(dir, "workshop.mp4");
      writeFileSync(mediaPath, "fake media");
      const env = { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath, KESHA_FAKE_TEXT_LANG_UNSUPPORTED: "1" };

      const run = await runCli(["--json", "--lang", "en", mediaPath], { env });
      expectContract(run, {
        exitCode: 0,
        stderrContains: [`${mediaPath}: warning: expected language "en" but detected "ru" (from audio)`],
      });
      expect(run.stderr.split("warning:")).toHaveLength(2);
      const [parsed] = JSON.parse(run.stdout);
      expect(parsed.lang).toBe("ru");
      expect(parsed.textLanguage).toEqual({ code: "ru", confidence: 0.2, source: "tinyld" });
    });
  });

  describe("--verbose", () => {
    /** Exploratory S1-2: `kesha --verbose a.ogg > t.txt` used to put three diagnostic lines above the transcript in the file. */
    test("diagnostics go to stderr and stdout carries the transcript alone", async () => {
      const dir = makeTempDir("kesha-cli-contract-verbose-channel-");
      const enginePath = createFakeEngine(dir);
      const mediaPath = join(dir, "workshop.mp4");
      writeFileSync(mediaPath, "fake media");

      const run = await runCli(["--verbose", mediaPath], {
        env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
      });
      expectContract(run, {
        exitCode: 0,
        stderrContains: ["Audio language: ru (confidence: 0.99)", "Text language: ru (confidence: 0.98)", "STT time: "],
        stdoutNotContains: ["language", "STT time", "---"],
      });
      expect(run.stdout.split("\n")).toHaveLength(1);
    });
  });

  describe("record under --quiet", () => {
    function recordingStub(dir: string, features: string[], body: string): string {
      const enginePath = join(dir, "kesha-engine");
      writeFileSync(
        enginePath,
        `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features })}'\n  exit 0\nfi\nif [ "$1" = "record" ]; then\n${body}\n  exit 0\nfi\nexit 2\n`,
      );
      chmodSync(enginePath, 0o755);
      return enginePath;
    }

    /** Exploratory S3-F2: `kesha record -q --out f.wav` produced nothing on either channel, so a script had no success signal. */
    test("--out still confirms the recording on stderr", async () => {
      if (process.platform === "win32") return;
      const dir = makeTempDir("kesha-cli-contract-record-quiet-out-");
      const outPath = join(dir, "note.wav");
      const enginePath = recordingStub(
        dir,
        [],
        `  printf '%s\\n' '{"kind":"progress","message":"Listening (48000 Hz)... stop with Ctrl-C."}' >&2
  printf '%s\\n' '{"kind":"progress","message":"Recorded ${outPath} (48000 Hz, 1 channel, 95744 frames)"}' >&2`,
      );
      const run = await runCli(["record", "-q", "--out", outPath], {
        env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
      });
      expectContract(run, {
        exitCode: 0,
        stdoutEmpty: true,
        stderrContains: [`Recorded ${outPath} (48000 Hz, 1 channel, 95744 frames)`],
        stderrNotContains: ["Listening"],
      });
    });

    test("--live on silence still says no speech was detected", async () => {
      if (process.platform === "win32") return;
      const dir = makeTempDir("kesha-cli-contract-record-quiet-live-");
      const enginePath = recordingStub(
        dir,
        ["record.live"],
        `  printf '%s\\n' '{"kind":"progress","message":"Listening... 1s"}' >&2
  printf '%s\\n' '{"kind":"progress","message":"No speech detected."}' >&2`,
      );
      const run = await runCli(["record", "-q", "--live"], {
        env: { ...isolatedEnv(dir), KESHA_ENGINE_BIN: enginePath },
      });
      expectContract(run, {
        exitCode: 0,
        stdoutEmpty: true,
        stderrContains: ["No speech detected."],
        stderrNotContains: ["Listening"],
      });
    });
  });
});
