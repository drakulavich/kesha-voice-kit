import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_TIMEOUT_MS, runCliScenario } from "./cli-scenario";

setDefaultTimeout(DEFAULT_TIMEOUT_MS * 2);

/**
 * The TS mirror of `rust/tests/error_codes_cli.rs` (#998). The engine codes every failure it
 * rejects; the failures the CLI rejects first were coded by nothing, so the same command shape
 * carried two different contracts depending on which layer caught it. This walks the inputs the
 * CLI answers on its own and holds them to the published `error [E_*]` line.
 */
const CODED_ERROR = /error \[E_[A-Z0-9_]+\]:/;

interface BadInput {
  name: string;
  skip?: boolean;
  prepare(dir: string): { args: string[]; env?: Record<string, string>; stderrContains: string[] };
}

const KNOWN_BAD_INPUTS: BadInput[] = [
  {
    name: "a directory where an audio file is expected",
    prepare(dir) {
      const target = join(dir, "a-directory");
      mkdirSync(target);
      return { args: [target], stderrContains: ["is a directory (expected an audio file)"] };
    },
  },
  {
    name: "a symlink pointing at nothing",
    // Creating one needs Developer Mode or an elevated shell on Windows.
    skip: process.platform === "win32",
    prepare(dir) {
      const link = join(dir, "dangling.wav");
      symlinkSync(join(dir, "gone.wav"), link);
      return { args: [link], stderrContains: ["File not found"] };
    },
  },
  {
    name: "KESHA_CACHE_DIR naming a directory this user cannot write into",
    // chmod frees neither root nor a Windows directory of the write bit.
    skip: process.platform === "win32" || process.getuid?.() === 0,
    prepare(dir) {
      const readOnly = join(dir, "read-only");
      mkdirSync(readOnly);
      chmodSync(readOnly, 0o500);
      return {
        args: ["install"],
        env: { KESHA_CACHE_DIR: readOnly },
        stderrContains: ["KESHA_CACHE_DIR", readOnly],
      };
    },
  },
  {
    name: "KESHA_CACHE_DIR naming a regular file",
    prepare(dir) {
      const file = join(dir, "not-a-dir");
      writeFileSync(file, "");
      return {
        args: ["install"],
        env: { KESHA_CACHE_DIR: file },
        stderrContains: ["KESHA_CACHE_DIR", file],
      };
    },
  },
];

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-error-codes-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("failures the CLI answers without the engine", () => {
  for (const input of KNOWN_BAD_INPUTS) {
    test.skipIf(input.skip === true)(`${input.name} prints a coded error`, async () => {
      const dir = makeTempDir();
      const { args, env, stderrContains } = input.prepare(dir);
      const run = await runCliScenario(args, {
        env: {
          HOME: dir,
          KESHA_CACHE_DIR: join(dir, "cache"),
          KESHA_LOG_DIR: join(dir, "logs"),
          KESHA_STATS_DB: join(dir, "stats.sqlite"),
          ...env,
        },
      });

      expect(run.exitCode).not.toBe(0);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(CODED_ERROR);
      for (const needle of stderrContains) {
        expect(run.stderr).toContain(needle);
      }
    });
  }
});
