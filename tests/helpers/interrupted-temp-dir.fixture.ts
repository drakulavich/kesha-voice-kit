import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tempDir } from "./temp-dir";

const WAIT_MS = 30_000;

/** Run only as a child of `temp-dir-leak-guard.test.ts`; the parent interrupts it mid-test on purpose. */
test(
  "stages a temp directory and waits to be interrupted",
  async () => {
    writeFileSync(process.env.KESHA_TEMP_DIR_FIXTURE_OUT!, tempDir("kesha-temp-dir-interrupt-"));
    await Bun.sleep(WAIT_MS);
  },
  WAIT_MS + 10_000,
);
