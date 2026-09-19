import { test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stubbornShell } from "./process";
import { tempDir } from "./temp-dir";

const LEAK_TTL_S = 30;

/** Run only as a child of `temp-dir-leak-guard.test.ts`; the leaked process and the unremovable directory are both the point. */
test("leaks a process, and a directory whose removal fails", () => {
  const dir = tempDir("kesha-temp-dir-wedged-");
  writeFileSync(join(dir, "held"), "x");
  writeFileSync(process.env.KESHA_TEMP_DIR_FIXTURE_OUT!, dir);

  const proc = Bun.spawn(
    ["sh", "-c", stubbornShell("TERM INT", LEAK_TTL_S), "kesha-engine-leak-guard-fixture"],
    { stdout: "ignore", stderr: "ignore" },
  );
  proc.unref();

  chmodSync(dir, 0o500);
});
