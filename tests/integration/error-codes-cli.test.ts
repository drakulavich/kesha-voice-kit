import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { DEFAULT_TIMEOUT_MS, runCliScenario } from "./cli-scenario";

setDefaultTimeout(DEFAULT_TIMEOUT_MS * 2);

/**
 * The TS mirror of `rust/tests/error_codes_cli.rs` (#998). The engine codes every failure it
 * rejects; the failures the CLI rejects first were coded by nothing, so the same command shape
 * carried two different contracts depending on which layer caught it. This walks the inputs the
 * CLI answers on its own and holds them to the published `error [E_*]` line — the generic shape
 * as the Rust test does, plus the specific code, so a remap to a wrong-but-published code is red.
 */
const CODED_ERROR = /error \[E_[A-Z0-9_]+\]:/;

/** A version no release will ever carry: if the guard under test regresses, the run fails fast
 * on the release lookup instead of downloading a real engine in the fast lane. */
const UNRELEASED = "0.0.0-does-not-exist";

interface BadInputSpec {
  args: string[];
  env?: Record<string, string>;
  code: string;
  stderrContains: string[];
  stderrNotContains?: string[];
  /** Result lines the command legitimately prints before failing; stdout stays empty otherwise. */
  stdoutContains?: string[];
}

interface BadInput {
  name: string;
  skip?: boolean;
  /** null when the filesystem ignored the mode bits, so the scenario could not be staged. */
  prepare(dir: string): BadInputSpec | null;
}

/** chmod is advisory on some filesystems; asserting on a directory that stayed writable proves nothing. */
function stageUnwritableDir(parent: string, name: string): string | null {
  const target = join(parent, name);
  mkdirSync(target);
  chmodSync(target, 0o500);
  try {
    accessSync(target, constants.W_OK);
    return null;
  } catch {
    return target;
  }
}

const KNOWN_BAD_INPUTS: BadInput[] = [
  {
    name: "a directory where an audio file is expected",
    prepare(dir) {
      const target = join(dir, "a-directory");
      mkdirSync(target);
      return {
        args: [target],
        code: "E_INVALID_ARG",
        stderrContains: ["is a directory (expected an audio file)"],
      };
    },
  },
  {
    name: "a symlink pointing at nothing",
    // Creating one needs Developer Mode or an elevated shell on Windows.
    skip: process.platform === "win32",
    prepare(dir) {
      const link = join(dir, "dangling.wav");
      symlinkSync(join(dir, "gone.wav"), link);
      return { args: [link], code: "E_INPUT_NOT_FOUND", stderrContains: ["File not found"] };
    },
  },
  {
    name: "KESHA_CACHE_DIR naming a directory this user cannot write into",
    // chmod frees neither root nor a Windows directory of the write bit.
    skip: process.platform === "win32" || process.getuid?.() === 0,
    prepare(dir) {
      const readOnly = stageUnwritableDir(dir, "read-only");
      if (!readOnly) return null;
      return {
        args: ["install", "--engine-version", UNRELEASED],
        env: { KESHA_CACHE_DIR: readOnly },
        code: "E_INVALID_ARG",
        stderrContains: [
          "KESHA_CACHE_DIR",
          readOnly,
          "Fix: point KESHA_CACHE_DIR at a writable directory",
        ],
        stderrNotContains: ["EACCES:"],
      };
    },
  },
  {
    name: "KESHA_CACHE_DIR naming a regular file",
    prepare(dir) {
      const file = join(dir, "not-a-dir");
      writeFileSync(file, "");
      return {
        args: ["install", "--engine-version", UNRELEASED],
        env: { KESHA_CACHE_DIR: file },
        code: "E_INVALID_ARG",
        stderrContains: [
          "KESHA_CACHE_DIR",
          file,
          "Fix: point KESHA_CACHE_DIR at a directory instead of a file",
        ],
        stderrNotContains: ["ENOTDIR:"],
      };
    },
  },
  {
    // KESHA_ENGINE_BIN wins over KESHA_CACHE_DIR, and it names a file: advising a "writable
    // directory" here would make the next install treat that directory as the engine binary.
    name: "KESHA_ENGINE_BIN under a parent directory that cannot be created",
    skip: process.platform === "win32" || process.getuid?.() === 0,
    prepare(dir) {
      const readOnly = stageUnwritableDir(dir, "read-only-parent");
      if (!readOnly) return null;
      const binPath = join(readOnly, "engine", "bin", "kesha-engine");
      return {
        args: ["install", "--engine-version", UNRELEASED],
        env: { KESHA_ENGINE_BIN: binPath },
        code: "E_INVALID_ARG",
        stderrContains: [
          "KESHA_ENGINE_BIN",
          binPath,
          "Fix: point KESHA_ENGINE_BIN at a writable path",
        ],
        stderrNotContains: ["EACCES:"],
      };
    },
  },
  {
    // mkdir(<file>) raises EEXIST, not the ENOTDIR of mkdir(<file>/sub): the same misconfiguration
    // reaches the same code only if both errnos map to it.
    name: "KESHA_ENGINE_BIN whose parent directory is itself a regular file",
    prepare(dir) {
      const file = join(dir, "not-a-dir");
      writeFileSync(file, "");
      const binPath = join(file, "kesha-engine");
      return {
        args: ["install", "--engine-version", UNRELEASED],
        env: { KESHA_ENGINE_BIN: binPath },
        code: "E_INVALID_ARG",
        stderrContains: [
          "KESHA_ENGINE_BIN",
          binPath,
          "Fix: point KESHA_ENGINE_BIN at a path whose parent directories are directories, not files",
        ],
        stderrNotContains: ["EEXIST:"],
      };
    },
  },
  {
    // The engine directory exists and cannot be written — the sibling of "cannot be created"
    // above, and what a Nix read-only-store install hits on every run (#1018).
    name: "an existing engine directory this user cannot write into",
    skip: process.platform === "win32" || process.getuid?.() === 0,
    prepare(dir) {
      const engineDir = stageUnwritableDir(dir, "read-only-engine");
      if (!engineDir) return null;
      return {
        args: ["install", "--engine-version", UNRELEASED],
        env: { KESHA_ENGINE_BIN: join(engineDir, "kesha-engine") },
        code: "E_INVALID_ARG",
        stderrContains: [
          `Cannot install engine v${UNRELEASED}`,
          `${engineDir} is not writable`,
          "Fix: point KESHA_ENGINE_BIN at a writable path",
        ],
        // The pin-override notice is a `kesha install` result line, printed before the failure.
        stdoutContains: [`Installing engine v${UNRELEASED} instead of the pinned`],
      };
    },
  },
  {
    // Waiting is bounded, and the end of the wait is a failure like any other: a lock held by a
    // live owner we cannot outlast. KESHA_INSTALL_LOCK_WAIT_SECS is what makes it a test rather
    // than an afternoon.
    name: "an install that gives up waiting for another install to release the cache",
    prepare(dir) {
      const binPath = join(dir, "engine", "bin", "kesha-engine");
      const lockDir = `${binPath}.lock`;
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "owner-held.json"),
        JSON.stringify({
          token: "held",
          pid: process.pid,
          host: hostname(),
          startedAt: Date.now(),
        }),
      );
      return {
        args: ["install", "--engine-version", UNRELEASED],
        env: { KESHA_ENGINE_BIN: binPath, KESHA_INSTALL_LOCK_WAIT_SECS: "1" },
        code: "E_INSTALL_RACE",
        stderrContains: [
          "Gave up after",
          `held by pid ${process.pid}`,
          `${lockDir} and re-run`,
        ],
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
      const spec = input.prepare(dir);
      if (!spec) return;
      const {
        args,
        env,
        code,
        stderrContains,
        stderrNotContains = [],
        stdoutContains = [],
      } = spec;
      const run = await runCliScenario(args, {
        env: {
          HOME: dir,
          // An exported KESHA_ENGINE_BIN would otherwise outrank the cache paths under test.
          KESHA_ENGINE_BIN: "",
          KESHA_CACHE_DIR: join(dir, "cache"),
          KESHA_LOG_DIR: join(dir, "logs"),
          KESHA_STATS_DB: join(dir, "stats.sqlite"),
          ...env,
        },
      });

      expect(run.exitCode).not.toBe(0);
      if (stdoutContains.length === 0) expect(run.stdout).toBe("");
      for (const needle of stdoutContains) {
        expect(run.stdout).toContain(needle);
      }
      expect(run.stdout).not.toMatch(CODED_ERROR);
      expect(run.stderr).toMatch(CODED_ERROR);
      expect(run.stderr).toContain(`error [${code}]:`);
      for (const needle of stderrContains) {
        expect(run.stderr).toContain(needle);
      }
      for (const needle of stderrNotContains) {
        expect(run.stderr).not.toContain(needle);
      }
    });
  }
});
