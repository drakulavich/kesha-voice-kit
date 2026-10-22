import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runInPty } from "../helpers/pty";
import { tempDir } from "../helpers/temp-dir";

const AUDIO = "tests/fixtures/benchmark-en/01-check-email.ogg";
const OFFER = "Download them now?";
// Every run preloads it, so a broken branch that installs fails offline instead of downloading.
const KESHA = ["bun", "--preload", join(import.meta.dir, "..", "helpers", "no-network.ts"), "bin/kesha.js"];

const ptyTest = process.platform === "win32" ? test.skip : test;

function freshEnv(): Record<string, string | undefined> {
  const home = tempDir("kesha-pty-");
  return {
    ...process.env,
    KESHA_ENGINE_BIN: undefined,
    KESHA_HOME: home,
    KESHA_CACHE_DIR: join(home, "cache"),
    NO_COLOR: "1",
  };
}

describe("first-run install offer on a terminal (#1412)", () => {
  ptyTest(
    "no: nothing is installed and the run fails with the init hint",
    async () => {
      const run = runInPty([...KESHA, AUDIO], freshEnv());
      await run.waitFor(OFFER);
      run.write("n");
      const code = await run.exited();
      expect(code).not.toBe(0);
      expect(run.output()).toContain("│  No");
      expect(run.output()).toContain("E_ENGINE_SPAWN");
      expect(run.output()).toContain("kesha init");
      expect(run.output()).not.toContain("SHA256SUMS");
    },
    60_000,
  );

  ptyTest(
    "yes: the install starts",
    async () => {
      const run = runInPty([...KESHA, AUDIO], freshEnv());
      await run.waitFor(OFFER);
      run.write("y");
      const code = await run.exited();
      expect(code).not.toBe(0);
      expect(run.output()).toContain("│  Yes");
      expect(run.output()).toContain("Failed to fetch SHA256SUMS");
    },
    60_000,
  );

  ptyTest(
    "piped stdout: no offer, and the hint names install",
    async () => {
      const run = runInPty(["bash", "-c", `set -o pipefail; ${KESHA.join(" ")} ${AUDIO} | cat`], freshEnv());
      const code = await run.exited();
      expect(code).not.toBe(0);
      expect(run.output()).not.toContain(OFFER);
      expect(run.output()).toContain("E_ENGINE_SPAWN");
      expect(run.output()).toContain("kesha install");
    },
    60_000,
  );
});
