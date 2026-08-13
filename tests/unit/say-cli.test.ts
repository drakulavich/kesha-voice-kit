import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sayCommand, shouldRejectMissingSayText } from "../../src/cli/say";
import { saveEngineEnv } from "../helpers/fake-engine";

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

/** A stub engine whose `say` fails the way the real one does: an `error [CODE]:` line and a status. */
function failingEngine(exitCode: number, stderrLine: string): string {
  const dir = tempDir("kesha-say-fail-");
  const binPath = join(dir, "kesha-engine");
  writeFileSync(
    binPath,
    `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${stderrLine}' >&2\nexit ${exitCode}\n`,
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
    failingEngine(3, "error [E_VOICE_NOT_FOUND]: voice zz-nobody is not installed");

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
    failingEngine(1, "error [E_INTERNAL]: synthesis aborted");

    const { exitCode, stderr } = await runSay({ text: "Hello", voice: "en-am_michael", rate: "1.0" });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("synthesis aborted");
  });
});
