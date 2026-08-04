import { describe, expect, test } from "bun:test";
import {
  alphaTag,
  assertPassesVersionGate,
  deriveAlpha,
  nextSequence,
} from "../../.github/scripts/derive-alpha-version";

const PKG = { version: "1.27.0", keshaEngine: { version: "1.24.7" } };
const SOME_TAGS = ["v1.24.7", "v1.26.0-cli", "v1.22.0-beta.1"];

describe("nextSequence", () => {
  test("starts at 1 when the base has no alphas yet", () => {
    expect(nextSequence("cli", "1.27.0", SOME_TAGS)).toBe(1);
  });

  test("takes one above the highest existing alpha, not the count", () => {
    const tags = [...SOME_TAGS, "v1.27.0-alpha.1-cli", "v1.27.0-alpha.7-cli"];

    expect(nextSequence("cli", "1.27.0", tags)).toBe(8);
  });

  test("compares sequences numerically, not as strings", () => {
    const tags = [...SOME_TAGS, "v1.27.0-alpha.9-cli", "v1.27.0-alpha.10-cli"];

    expect(nextSequence("cli", "1.27.0", tags)).toBe(11);
  });

  test("ignores alphas of a different base", () => {
    expect(nextSequence("cli", "1.27.0", [...SOME_TAGS, "v1.26.0-alpha.5-cli"])).toBe(1);
  });

  test("ignores the other artifact's alphas", () => {
    expect(nextSequence("cli", "1.27.0", [...SOME_TAGS, "v1.27.0-alpha.5"])).toBe(1);
    expect(nextSequence("engine", "1.27.0", [...SOME_TAGS, "v1.27.0-alpha.5-cli"])).toBe(1);
  });

  test("ignores malformed tags rather than mis-counting", () => {
    const tags = [...SOME_TAGS, "v1.27.0-alpha-cli", "v1.27.0-alpha.x-cli", "1.27.0-alpha.3-cli"];

    expect(nextSequence("cli", "1.27.0", tags)).toBe(1);
  });

  // A shallow checkout has no tags and is indistinguishable from a fresh repo (#685).
  test("refuses to derive when no tags are visible at all", () => {
    expect(() => nextSequence("cli", "1.27.0", [])).toThrow(/no tags visible/);
  });
});

describe("alphaTag", () => {
  test("a CLI alpha carries the marker the engine build filters out", () => {
    expect(alphaTag("cli", "1.27.0", 3)).toBe("v1.27.0-alpha.3-cli");
  });

  test("an engine alpha does not", () => {
    expect(alphaTag("engine", "1.24.8", 3)).toBe("v1.24.8-alpha.3");
  });
});

describe("assertPassesVersionGate", () => {
  test("accepts a version that leads the engine", () => {
    expect(() => assertPassesVersionGate("1.27.0-alpha.1", "1.24.7")).not.toThrow();
  });

  // A prerelease sorts below its own stable version, so an equal base fails check:versions.
  test("rejects a base equal to the engine version", () => {
    expect(() => assertPassesVersionGate("1.24.7-alpha.1", "1.24.7")).toThrow(/check:versions/);
  });
});

describe("deriveAlpha", () => {
  test("the CLI base comes from the next unreleased version on main", () => {
    expect(deriveAlpha("cli", PKG, SOME_TAGS)).toEqual({
      version: "1.27.0-alpha.1",
      tag: "v1.27.0-alpha.1-cli",
      sequence: 1,
    });
  });

  test("an engine alpha must name its target rather than inherit the released one", () => {
    expect(() => deriveAlpha("engine", PKG, SOME_TAGS)).toThrow(/needs its target version/);
  });

  test("an engine alpha derives from the named target", () => {
    expect(deriveAlpha("engine", PKG, SOME_TAGS, "1.24.8")).toEqual({
      version: "1.24.8-alpha.1",
      tag: "v1.24.8-alpha.1",
      sequence: 1,
    });
  });

  test("refuses an engine target at or below what is already released", () => {
    for (const base of ["1.24.7", "1.24.6"]) {
      expect(() => deriveAlpha("engine", PKG, SOME_TAGS, base)).toThrow(/must be above/);
    }
  });

  test("refuses a base that is already a prerelease", () => {
    const pkg = { version: "1.27.0-alpha.1", keshaEngine: { version: "1.24.7" } };

    expect(() => deriveAlpha("cli", pkg, SOME_TAGS)).toThrow(/must be a stable version/);
  });
});
