import { describe, expect, test } from "bun:test";
import { packedFiles, publishableChanges } from "../../.github/scripts/alpha-publishable";

const PACKED = ["package.json", "bin/kesha.js", "src/engine.ts", "README.md"];

describe("publishableChanges", () => {
  test("a change to a packed file publishes", () => {
    expect(publishableChanges(["src/engine.ts"], PACKED)).toEqual(["src/engine.ts"]);
  });

  test("repo tooling that is not packed publishes nothing", () => {
    const changed = [".github/workflows/ci.yml", "tests/unit/init.test.ts", "rust/src/models.rs"];

    expect(publishableChanges(changed, PACKED)).toEqual([]);
  });

  // The whole point of asking npm: a path under a shipped directory can still be excluded.
  test("a path inside a shipped directory that npm does not pack publishes nothing", () => {
    expect(publishableChanges(["src/__tests__/error-codes.test.ts"], PACKED)).toEqual([]);
  });

  test("reports every matching path, not just the first", () => {
    expect(publishableChanges(["src/engine.ts", "docs/x.md", "bin/kesha.js"], PACKED)).toEqual([
      "src/engine.ts",
      "bin/kesha.js",
    ]);
  });
});

describe("packedFiles", () => {
  test("reads the path list npm reports", () => {
    const out = JSON.stringify([{ files: [{ path: "bin/kesha.js" }, { path: "src/engine.ts" }] }]);

    expect(packedFiles(out)).toEqual(["bin/kesha.js", "src/engine.ts"]);
  });

  test("refuses an empty pack rather than skipping every alpha forever", () => {
    expect(() => packedFiles(JSON.stringify([{ files: [] }]))).toThrow(/refusing to guess/);
  });
});
