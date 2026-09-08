import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers/repo";
import { reapTempDirs, tempDir } from "../helpers/temp-dir";

const FIXTURE = "./tests/helpers/leaked-temp-dir.fixture.ts";

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
});
