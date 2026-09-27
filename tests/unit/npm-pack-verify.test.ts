import { describe, expect, test } from "bun:test";
import { packedPackageProblems } from "../../.github/scripts/npm-pack-verify";

const pin = { version: "2.0.0", sha256: { "kesha-engine-linux-x64": "a".repeat(64) }, size: { "kesha-engine-linux-x64": 1 } };

describe("packedPackageProblems", () => {
  test("a tarball carrying the release version and its Engine pin passes", () => {
    expect(packedPackageProblems({ version: "2.0.0", kesha: { engine: pin } }, { version: "2.0.0", engineVersion: "2.0.0" })).toEqual([]);
  });

  test("a tarball published under another version fails, naming both", () => {
    expect(packedPackageProblems({ version: "1.32.0", kesha: { engine: pin } }, { version: "2.0.0", engineVersion: "2.0.0" })).toEqual([
      "packed version is 1.32.0, expected 2.0.0",
    ]);
  });

  test("a tarball without an injected pin fails rather than falling back to a committed one", () => {
    expect(packedPackageProblems({ version: "2.0.0", keshaEngine: { version: "1.26.0" } }, { version: "2.0.0", engineVersion: "2.0.0" })).toEqual([
      "packed package.json carries no kesha.engine pin",
    ]);
  });

  test("a pin naming another Engine fails", () => {
    expect(packedPackageProblems({ version: "2.1.0-alpha.1", kesha: { engine: pin } }, { version: "2.1.0-alpha.1", engineVersion: "2.0.1" })).toEqual([
      "packed Engine pin is v2.0.0, expected v2.0.1",
    ]);
  });
});
