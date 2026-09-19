import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers/repo";
import { createTempDirRegistry, sweepStaleTempDirs } from "../helpers/temp-dir";

const FIXTURE = "./tests/helpers/leaked-temp-dir.fixture.ts";
const WEDGED_FIXTURE = "./tests/helpers/wedged-temp-dir.fixture.ts";
const INTERRUPTED_FIXTURE = "./tests/helpers/interrupted-temp-dir.fixture.ts";

/** A read-only directory is how POSIX reaches the branch Windows reaches with EPERM on an open handle; root ignores the mode. */
const wedgeable = process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test;
const posix = process.platform === "win32" ? test.skip : test;

const POLL_INTERVAL_MS = 25;
const POLL_ATTEMPTS = 400;

async function waitForPath(file: string): Promise<string> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (existsSync(file)) {
      const staged = readFileSync(file, "utf8");
      if (staged !== "") return staged;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for the fixture to stage a directory: ${file}`);
}

describe("temp directory leak guard", () => {
  test("removes a directory the test never cleaned up, and names it", () => {
    const registry = createTempDirRegistry();
    const dir = registry.tempDir("kesha-temp-dir-guard-");
    expect(existsSync(dir)).toBe(true);

    const reaped = registry.reapTempDirs();

    expect(reaped).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });

  /** Suites that already clean up by hand keep working unchanged. */
  test("tolerates a directory the test removed itself", () => {
    const registry = createTempDirRegistry();
    const dir = registry.tempDir("kesha-temp-dir-guard-");
    rmSync(dir, { recursive: true, force: true });

    expect(registry.reapTempDirs()).toContain(dir);
  });

  test("reaps a directory a whole suite left behind, without the suite asking", () => {
    const registry = createTempDirRegistry();
    const out = join(registry.tempDir("kesha-temp-dir-guard-"), "leaked-path");

    try {
      const run = Bun.spawnSync(["bun", "test", FIXTURE], {
        cwd: REPO_ROOT,
        env: { ...process.env, KESHA_TEMP_DIR_FIXTURE_OUT: out },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(run.stderr.toString()).toContain("1 pass");
      const leaked = readFileSync(out, "utf8");
      expect(leaked).toContain("kesha-temp-dir-fixture-");
      expect(existsSync(leaked)).toBe(false);
    } finally {
      registry.reapTempDirs();
    }
  });

  posix("reaps what an interrupted run staged, which no afterAll ever sees", async () => {
    const registry = createTempDirRegistry();
    const out = join(registry.tempDir("kesha-temp-dir-guard-"), "leaked-path");
    let staged = "";

    try {
      const run = Bun.spawn(["bun", "test", INTERRUPTED_FIXTURE], {
        cwd: REPO_ROOT,
        env: { ...process.env, KESHA_TEMP_DIR_FIXTURE_OUT: out },
        stdout: "ignore",
        stderr: "ignore",
      });
      staged = await waitForPath(out);
      expect(existsSync(staged)).toBe(true);

      run.kill("SIGINT");
      await run.exited;

      expect(existsSync(staged)).toBe(false);
    } finally {
      registry.reapTempDirs();
      if (staged !== "") rmSync(staged, { recursive: true, force: true });
    }
  });

  wedgeable("removes the rest when one directory refuses to go, and leaves it out of the list", () => {
    const registry = createTempDirRegistry();
    const wedged = registry.tempDir("kesha-temp-dir-guard-");
    writeFileSync(join(wedged, "held"), "x");
    chmodSync(wedged, 0o500);
    const other = registry.tempDir("kesha-temp-dir-guard-");

    try {
      const reaped = registry.reapTempDirs();

      expect(reaped).toContain(other);
      expect(reaped).not.toContain(wedged);
      expect(existsSync(other)).toBe(false);
    } finally {
      chmodSync(wedged, 0o700);
      rmSync(wedged, { recursive: true, force: true });
    }
  });

  wedgeable("keeps a directory it could not remove, so the exit pass gets another go", () => {
    const registry = createTempDirRegistry();
    const wedged = registry.tempDir("kesha-temp-dir-guard-");
    writeFileSync(join(wedged, "held"), "x");
    chmodSync(wedged, 0o500);
    try {
      expect(registry.reapTempDirs()).not.toContain(wedged);
      chmodSync(wedged, 0o700);

      expect(registry.reapTempDirs()).toContain(wedged);
      expect(existsSync(wedged)).toBe(false);
    } finally {
      if (existsSync(wedged)) chmodSync(wedged, 0o700);
      rmSync(wedged, { recursive: true, force: true });
    }
  });

  wedgeable("still reports the processes a suite leaked when a directory refuses to go", () => {
    const registry = createTempDirRegistry();
    const out = join(registry.tempDir("kesha-temp-dir-guard-"), "leaked-path");
    let wedged = "";

    try {
      const run = Bun.spawnSync(["bun", "test", WEDGED_FIXTURE], {
        cwd: REPO_ROOT,
        env: { ...process.env, KESHA_TEMP_DIR_FIXTURE_OUT: out },
        stdout: "pipe",
        stderr: "pipe",
      });
      wedged = readFileSync(out, "utf8");

      expect(run.stderr.toString()).toContain("process(es) running");
    } finally {
      registry.reapTempDirs();
      if (wedged !== "") {
        chmodSync(wedged, 0o700);
        rmSync(wedged, { recursive: true, force: true });
      }
    }
  });
});

describe("stale temp directory sweep", () => {
  const LONG_AGO = new Date(Date.now() - 5 * 60 * 60 * 1000);

  function stage(root: string, name: string, age: "stale" | "fresh"): string {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "held"), "x");
    if (age === "stale") utimesSync(dir, LONG_AGO, LONG_AGO);
    return dir;
  }

  test("removes what a run nothing survived left behind, and leaves a live run's directory alone", () => {
    const registry = createTempDirRegistry();
    const root = registry.tempDir("kesha-temp-dir-guard-");

    try {
      const stale = stage(root, "kesha-temp-dir-sweep-a1b2c3", "stale");
      const fresh = stage(root, "kesha-temp-dir-sweep-d4e5f6", "fresh");

      expect(sweepStaleTempDirs(root)).toEqual([stale]);

      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      registry.reapTempDirs();
    }
  });

  test("runs at preload, so the run after a killed one is what cleans up its directories", () => {
    const registry = createTempDirRegistry();
    const out = join(registry.tempDir("kesha-temp-dir-guard-"), "leaked-path");
    const abandoned = registry.tempDir("kesha-temp-dir-abandoned-");
    utimesSync(abandoned, LONG_AGO, LONG_AGO);

    try {
      const run = Bun.spawnSync(["bun", "test", FIXTURE], {
        cwd: REPO_ROOT,
        env: { ...process.env, KESHA_TEMP_DIR_FIXTURE_OUT: out },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(run.stderr.toString()).toContain("1 pass");
      expect(existsSync(abandoned)).toBe(false);
    } finally {
      registry.reapTempDirs();
      rmSync(abandoned, { recursive: true, force: true });
    }
  });

  /** The temp root holds the MCP audio cache and whatever else the machine put there; only the sub-root is the helper's to delete. */
  test("cannot reach the temp root at all, whatever a directory there is called", () => {
    const decoy = join(tmpdir(), `kesha-important-backup-${process.pid}-a1b2c3`);
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "held"), "x");
    utimesSync(decoy, LONG_AGO, LONG_AGO);

    try {
      expect(sweepStaleTempDirs()).not.toContain(decoy);

      expect(existsSync(decoy)).toBe(true);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});
