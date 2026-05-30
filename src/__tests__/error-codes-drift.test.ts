import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { KNOWN_TS_CODES } from "../error-codes";

const ENGINE_BIN =
  process.env.KESHA_ENGINE_BIN ?? join(import.meta.dir, "../../rust/target/release/kesha-engine");

const describeOrSkip = existsSync(ENGINE_BIN) ? describe : describe.skip;

describeOrSkip("error-code drift", () => {
  test("engine codes ∪ TS-native codes == codes documented in docs/errors.md", () => {
    const res = spawnSync(ENGINE_BIN, ["--error-codes-json"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const engineCodes: string[] = JSON.parse(res.stdout).map((e: { code: string }) => e.code);

    const known = new Set<string>([...engineCodes, ...KNOWN_TS_CODES]);

    const doc = readFileSync(join(import.meta.dir, "../../docs/errors.md"), "utf8");
    const documented = new Set<string>();
    for (const m of doc.matchAll(/`(E_[A-Z0-9_]+)`/g)) documented.add(m[1]);

    // every known code is documented
    for (const c of known) expect(documented.has(c)).toBe(true);
    // every documented code is known (no stale doc rows)
    for (const c of documented) expect(known.has(c)).toBe(true);
  });
});
