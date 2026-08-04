import { describe, expect, test } from "bun:test";
import {
  packedFiles,
  parseNameStatus,
  publishableChanges,
  shippedPrefixes,
} from "../../.github/scripts/alpha-publishable";

const PACKED = ["package.json", "bin/kesha.js", "src/engine.ts", "README.md"];
const FILES = ["bin/", "src/", "package.json", "README.md", "!src/__tests__"];

const modified = (path: string) => ({ status: "M", path });
const deleted = (path: string) => ({ status: "D", path });

describe("publishableChanges", () => {
  test("a change to a packed file publishes", () => {
    expect(publishableChanges([modified("src/engine.ts")], PACKED, FILES)).toEqual([
      "src/engine.ts",
    ]);
  });

  test("repo tooling that is not packed publishes nothing", () => {
    const changed = [".github/workflows/ci.yml", "tests/unit/init.test.ts"].map(modified);

    expect(publishableChanges(changed, PACKED, FILES)).toEqual([]);
  });

  // The whole point of asking npm: a path under a shipped directory can still be excluded.
  test("a path inside a shipped directory that npm does not pack publishes nothing", () => {
    expect(publishableChanges([modified("src/__tests__/x.test.ts")], PACKED, FILES)).toEqual([]);
  });

  // The packer cannot answer for a file that no longer exists (Greptile #703 P1).
  test("deleting a shipped file publishes, even though the packer no longer lists it", () => {
    expect(publishableChanges([deleted("src/legacy.ts")], PACKED, FILES)).toEqual([
      "src/legacy.ts",
    ]);
  });

  test("deleting something that never shipped publishes nothing", () => {
    expect(publishableChanges([deleted("tests/unit/old.test.ts")], PACKED, FILES)).toEqual([]);
  });

  test("deleting under a negated prefix publishes nothing", () => {
    expect(publishableChanges([deleted("src/__tests__/gone.test.ts")], PACKED, FILES)).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  test("reads status and path", () => {
    expect(parseNameStatus("M\tsrc/engine.ts\nD\tsrc/legacy.ts")).toEqual([
      { status: "M", path: "src/engine.ts" },
      { status: "D", path: "src/legacy.ts" },
    ]);
  });

  // A rename lists both sides; the destination is the one that exists to be packed.
  test("a rename resolves to its destination", () => {
    expect(parseNameStatus("R096\tsrc/old.ts\tsrc/new.ts")).toEqual([
      { status: "R", path: "src/new.ts" },
    ]);
  });

  test("a path containing spaces survives", () => {
    expect(parseNameStatus("M\tdocs/a b.md")).toEqual([{ status: "M", path: "docs/a b.md" }]);
  });
});

describe("shippedPrefixes", () => {
  test("separates allowed prefixes from negated ones", () => {
    expect(shippedPrefixes(FILES)).toEqual({
      allow: ["bin", "src", "package.json", "README.md"],
      deny: ["src/__tests__"],
    });
  });
});

describe("packedFiles", () => {
  test("reads the path list npm reports", () => {
    const out = JSON.stringify([{ files: [{ path: "bin/kesha.js" }] }]);

    expect(packedFiles(out)).toEqual(["bin/kesha.js"]);
  });

  test("refuses an empty pack rather than skipping every alpha forever", () => {
    expect(() => packedFiles(JSON.stringify([{ files: [] }]))).toThrow(/refusing to guess/);
  });
});
