import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sayCommand, shouldRejectMissingSayText } from "../../src/cli/say";
import { describeJson, saveEngineEnv } from "../helpers/fake-engine";

describe("say CLI input guard (#324 P1)", () => {
  test("rejects missing text only when stdin is a TTY", () => {
    expect(shouldRejectMissingSayText(undefined, true)).toBe(true);
    expect(shouldRejectMissingSayText("", true)).toBe(true);
  });

  test("allows piped stdin when text is omitted", () => {
    expect(shouldRejectMissingSayText(undefined, false)).toBe(false);
    expect(shouldRejectMissingSayText(undefined, undefined)).toBe(false);
  });

  test("allows explicit positional text even from a TTY", () => {
    expect(shouldRejectMissingSayText("Hello", true)).toBe(false);
  });
});

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const undo of cleanups.splice(0).reverse()) undo();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stub engine whose `say` fails the way the real one does: a protocol 4 error event and a status. */
function failingEngine(exitCode: number, code: string, message: string): string {
  const dir = tempDir("kesha-say-fail-");
  const binPath = join(dir, "kesha-engine");
  writeFileSync(
    binPath,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["tts"] })}'\n  exit 0\nfi\ncat > /dev/null\nprintf '%s\\n' '{"kind":"error","code":"${code}","message":"${message}"}' >&2\nexit ${exitCode}\n`,
  );
  chmodSync(binPath, 0o755);
  cleanups.push(saveEngineEnv());
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** Runs `kesha say` in-process and returns the status it exits with plus everything it wrote to stderr. */
async function runSay(args: Record<string, unknown>): Promise<{ exitCode: number; stderr: string }> {
  const savedExit = process.exit;
  const savedWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as typeof process.exit;
  try {
    await sayCommand.run?.({ args } as never);
    return { exitCode: 0, stderr };
  } catch (err) {
    if (err instanceof ExitCalled) return { exitCode: err.code, stderr };
    throw err;
  } finally {
    process.exit = savedExit;
    process.stderr.write = savedWrite;
  }
}

const skipOnWin32 = process.platform === "win32" ? test.skip : test;

// Nothing exercised this path: `say.test.ts` only ever hands the CLI an engine that succeeds,
// so a failure flattened into "exit 1, generic message" would have gone unnoticed.
describe("kesha say relays an engine failure", () => {
  skipOnWin32("exits with the engine's own status and prints its stderr", async () => {
    failingEngine(3, "E_VOICE_NOT_FOUND", "voice zz-nobody is not installed");

    const { exitCode, stderr } = await runSay({
      text: "Hello",
      voice: "zz-nobody",
      out: join(tempDir("kesha-say-out-"), "reply.wav"),
      rate: "1.0",
    });

    expect(exitCode).toBe(3);
    expect(stderr).toContain("E_VOICE_NOT_FOUND");
    expect(stderr).toContain("voice zz-nobody is not installed");
  });

  skipOnWin32("does not swallow a failure into a success exit", async () => {
    failingEngine(1, "E_INTERNAL", "synthesis aborted");

    const { exitCode, stderr } = await runSay({ text: "Hello", voice: "en-am_michael", rate: "1.0" });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("synthesis aborted");
  });
});

/** A stub engine whose `say --list-voices` fails with a protocol 4 error event and a status, after answering `describe`. */
function failingListVoicesEngine(exitCode: number, code: string, message: string): string {
  const dir = tempDir("kesha-say-listfail-");
  const binPath = join(dir, "kesha-engine");
  writeFileSync(
    binPath,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["tts"] })}'\n  exit 0\nfi\nif [ "$1" = "say" ] && [ "$2" = "--list-voices" ]; then\n  printf '%s\\n' '{"kind":"error","code":"${code}","message":"${message}"}' >&2\n  exit ${exitCode}\nfi\necho "unexpected invocation: $*" >&2\nexit 99\n`,
  );
  chmodSync(binPath, 0o755);
  cleanups.push(saveEngineEnv());
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** A stub engine that answers `describe` with the given features and refuses anything else. */
function engineAdvertising(features: string[]): string {
  const dir = tempDir("kesha-say-describe-");
  const binPath = join(dir, "kesha-engine");
  writeFileSync(
    binPath,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features })}'\n  exit 0\nfi\necho "unexpected invocation: $@" >&2\nexit 9\n`,
  );
  chmodSync(binPath, 0o755);
  cleanups.push(saveEngineEnv());
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** A stub engine that fails `describe` outright, the way an engine predating protocol 4 would. */
function engineWithoutDescribe(exitCode: number): string {
  const dir = tempDir("kesha-say-nodescribe-");
  const binPath = join(dir, "kesha-engine");
  writeFileSync(binPath, `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(binPath, 0o755);
  cleanups.push(saveEngineEnv());
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** A stub engine whose `describe` answers with a genuine protocol 4 error event, not just a bad exit status. */
function engineDescribeReportsError(exitCode: number, code: string, message: string): string {
  const dir = tempDir("kesha-say-describe-err-");
  const binPath = join(dir, "kesha-engine");
  writeFileSync(
    binPath,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '{"kind":"error","code":"${code}","message":"${message}"}' >&2\n  exit ${exitCode}\nfi\necho "unexpected invocation: $*" >&2\nexit 99\n`,
  );
  chmodSync(binPath, 0o755);
  cleanups.push(saveEngineEnv());
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** Points `KESHA_ENGINE_BIN` at a path with nothing there, the way an unfinished install would. */
function missingEngine(): string {
  const dir = tempDir("kesha-say-missing-");
  const binPath = join(dir, "kesha-engine");
  cleanups.push(saveEngineEnv());
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

// getDescribe()/validateArgv() throw a bare KeshaError, not SayError — must not flatten to E_INTERNAL/exit 4.
describe("kesha say relays a bare KeshaError from the describe/validateArgv preflight", () => {
  skipOnWin32("an ungated flag reports E_INVALID_ARG and exits 2, never spawning `say`", async () => {
    engineAdvertising(["tts"]);

    const { exitCode, stderr } = await runSay({ text: "Hello", voice: "en-am_michael", rate: "1.2" });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("error [E_INVALID_ARG]:");
    expect(stderr).not.toContain("unexpected invocation");
  });

  skipOnWin32("an engine that fails `describe` reports E_ENGINE_PROTOCOL and exits 1, not the probe's own status", async () => {
    engineWithoutDescribe(2);

    const { exitCode, stderr } = await runSay({ text: "Hello", voice: "en-am_michael", rate: "1.0" });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("error [E_ENGINE_PROTOCOL]:");
    expect(stderr).toContain("kesha install");
  });

  skipOnWin32("a missing/unspawnable engine reports E_ENGINE_SPAWN and exits 1", async () => {
    missingEngine();

    const { exitCode, stderr } = await runSay({ text: "Hello", voice: "en-am_michael", rate: "1.0" });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("error [E_ENGINE_SPAWN]:");
    expect(stderr).toContain("kesha install");
  });
});

describe("kesha say --list-voices speaks protocol 4", () => {
  skipOnWin32("an engine that fails the listing exits with its status and prints the coded line", async () => {
    failingListVoicesEngine(3, "E_MODEL_MISSING", "no voices installed");
    const { exitCode, stderr } = await runSay({ "list-voices": true });
    expect(exitCode).toBe(3);
    expect(stderr).toContain("error [E_MODEL_MISSING]: no voices installed");
  });

  skipOnWin32("a build without tts is refused before any spawn", async () => {
    // No tts feature means no `say` subcommand at all (describe.rs's `("say", _) => TTS_BUILD`), not a gated flag.
    engineAdvertising([]);
    const { exitCode, stderr } = await runSay({ "list-voices": true });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("error [E_INVALID_ARG]:");
    expect(stderr).toContain("kesha-engine has no `say` subcommand");
    expect(stderr).not.toContain("unexpected invocation");
  });

  skipOnWin32("an engine that fails `describe` is E_ENGINE_PROTOCOL, exit 1", async () => {
    engineWithoutDescribe(3);
    const { exitCode, stderr } = await runSay({ "list-voices": true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error [E_ENGINE_PROTOCOL]:");
    expect(stderr).toContain("kesha install");
  });

  skipOnWin32("an engine whose describe reports an error event exits with its own status, not 4", async () => {
    engineDescribeReportsError(1, "E_MODEL_MISSING", "the TTS bundle is missing");
    const { exitCode, stderr } = await runSay({ "list-voices": true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error [E_MODEL_MISSING]: the TTS bundle is missing");
  });
});
