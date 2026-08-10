import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { KNOWN_TS_CODES } from "../error-codes";
import { enginePublishesJson } from "../../tests/helpers/engine-probe";

const ENGINE_BIN =
  process.env.KESHA_ENGINE_BIN ?? join(import.meta.dir, "../../rust/target/release/kesha-engine");

const describeOrSkip = enginePublishesJson(ENGINE_BIN, "--error-codes-json") ? describe : describe.skip;

describeOrSkip("error-code drift", () => {
  test("engine codes ∪ TS-native codes == codes documented in docs/errors.md", () => {
    const res = spawnSync(ENGINE_BIN, ["--error-codes-json"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const engineCodes: string[] = JSON.parse(res.stdout).map((e: { code: string }) => e.code);

    const known = new Set<string>([...engineCodes, ...KNOWN_TS_CODES]);

    const doc = readFileSync(join(import.meta.dir, "../../docs/errors.md"), "utf8");
    const documented = new Set<string>();
    for (const m of doc.matchAll(/`(E_[A-Z0-9_]+)`/g)) documented.add(m[1]);

    // Named both ways: a set-membership assertion only reports "false is not true".
    expect([...known].filter((c) => !documented.has(c)).sort()).toEqual([]);
    expect([...documented].filter((c) => !known.has(c)).sort()).toEqual([]);
  });
});
