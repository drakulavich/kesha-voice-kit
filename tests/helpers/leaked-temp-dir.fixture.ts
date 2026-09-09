import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tempDir } from "./temp-dir";

/** Run only as a child of `temp-dir-leak-guard.test.ts`; the leak it stages is the point. */
test("stages a temp directory and never removes it", () => {
  writeFileSync(process.env.KESHA_TEMP_DIR_FIXTURE_OUT!, tempDir("kesha-temp-dir-fixture-"));
});
