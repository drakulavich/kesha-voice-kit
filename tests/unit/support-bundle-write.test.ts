import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { join } from "path";
import { exitCodeFor, KeshaError } from "../../src/engine/events";
import { createSupportBundle } from "../../src/support-bundle";
import { tempDir } from "../helpers/temp-dir";

const ERRNO_TEXT: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
  ENOSPC: "no space left on device",
  EIO: "input/output error",
};

describe("support-bundle --output a disk refuses (#1345)", () => {
  const savedEnv = { HOME: process.env.HOME, KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR, KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN };
  let restoreWrite: (() => void) | null = null;

  beforeEach(() => {
    const dir = tempDir("kesha-support-bundle-write-");
    process.env.HOME = dir;
    process.env.KESHA_CACHE_DIR = join(dir, "cache");
    process.env.KESHA_ENGINE_BIN = join(dir, "engine", "kesha-engine");
  });

  afterEach(() => {
    restoreWrite?.();
    restoreWrite = null;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function failWriting(code: string): Promise<{ error: KeshaError; output: string }> {
    const output = join(process.env.HOME!, "out", "bundle.tar.gz");
    const spy = spyOn(fs, "writeFileSync").mockImplementation((path) => {
      throw Object.assign(new Error(`${code}: ${ERRNO_TEXT[code]}, open '${String(path)}'`), { code, syscall: "open", path });
    });
    restoreWrite = () => spy.mockRestore();
    const error = await createSupportBundle({ output }).then(
      () => { throw new Error("expected the bundle write to fail"); },
      (e: unknown) => e,
    );
    expect(spy).toHaveBeenCalled();
    expect(error).toBeInstanceOf(KeshaError);
    return { error: error as KeshaError, output };
  }

  for (const code of ["EACCES", "EPERM", "EROFS"]) {
    test(`${code} is a bad --output naming the path and asking for a writable one`, async () => {
      const { error, output } = await failWriting(code);
      expect(error.code).toBe("E_INVALID_ARG");
      expect(exitCodeFor(error)).toBe(2);
      expect(error.message).toContain(output);
      expect(error.message).toContain(code);
      expect(error.hint).toContain("--output");
    });
  }

  test("ENOSPC is E_INTERNAL naming the path and the full disk", async () => {
    const { error, output } = await failWriting("ENOSPC");
    expect(error.code).toBe("E_INTERNAL");
    expect(exitCodeFor(error)).toBe(4);
    expect(error.message).toContain(output);
    expect(error.hint).toContain("the disk is full");
  });

  test("a written archive is reported from what was written, so a failing stat afterwards cannot fail the run", async () => {
    const output = join(process.env.HOME!, "bundle.tar.gz");
    const realStat = fs.statSync;
    const spy = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, opts?: fs.StatSyncOptions) => {
      if (String(path) === output) throw Object.assign(new Error(`EIO: input/output error, stat '${output}'`), { code: "EIO" });
      return realStat(path, opts);
    }) as typeof fs.statSync);
    restoreWrite = () => spy.mockRestore();

    const bundle = await createSupportBundle({ output });

    expect(bundle.path).toBe(output);
    expect(bundle.sizeBytes).toBe(fs.readFileSync(output).byteLength);
  });

  test("any other disk errno is E_INTERNAL naming the path", async () => {
    const { error, output } = await failWriting("EIO");
    expect(error.code).toBe("E_INTERNAL");
    expect(error.message).toContain(output);
    expect(error.message).toContain("EIO");
    expect(error.hint).toContain("--output");
  });
});
