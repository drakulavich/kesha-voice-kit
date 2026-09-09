import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers/repo";
import { createTempDirRegistry, reapTempDirs, tempDir } from "../helpers/temp-dir";

const FIXTURE = "./tests/helpers/leaked-temp-dir.fixture.ts";
const WEDGED_FIXTURE = "./tests/helpers/wedged-temp-dir.fixture.ts";

/** A read-only directory is how POSIX reaches the branch Windows reaches with EPERM on an open handle; root ignores the mode. */
const wedgeable = process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test;

describe("temp directory leak guard", () => {
  test("removes a directory the test never cleaned up, and names it", () => {
    const dir = tempDir("kesha-temp-dir-guard-");
    expect(existsSync(dir)).toBe(true);

    const reaped = reapTempDirs();

    expect(reaped).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });

  /** Suites that already clean up by hand keep working unchanged. */
  test("tolerates a directory the test removed itself", () => {
    const dir = tempDir("kesha-temp-dir-guard-");
    rmSync(dir, { recursive: true, force: true });

    expect(reapTempDirs()).toContain(dir);
  });

  test("reaps a directory a whole suite left behind, without the suite asking", () => {
    const out = join(tempDir("kesha-temp-dir-guard-"), "leaked-path");

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
