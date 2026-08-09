import { describe, expect, test } from "bun:test";
import {
  alphaTag,
  assertPassesVersionGate,
  deriveAlpha,
  nextSequence,
  previousTag,
} from "../../.github/scripts/derive-alpha-version";
import { readRepoFile } from "../helpers/repo";

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

describe("previousTag", () => {
  const TAGS = ["v1.24.7", "v1.26.0-cli", "v1.27.0-alpha.1-cli", "v1.24.8-alpha.1", "v1.22.0-beta.1"];

  test("takes the highest published tag of its own channel", () => {
    expect(previousTag("cli", TAGS)).toBe("v1.27.0-alpha.1-cli");
    expect(previousTag("engine", TAGS)).toBe("v1.24.8-alpha.1");
  });

  test("compares by SemVer, not lexically", () => {
    const tags = ["v1.27.0-alpha.2-cli", "v1.27.0-alpha.10-cli"];
    expect(previousTag("cli", tags)).toBe("v1.27.0-alpha.10-cli");
  });

  // Anchoring at an old alpha would make the next alpha's notes span every stable since.
  test("takes a stable released after the last alpha", () => {
    const tags = ["v1.24.8-alpha.2", "v1.25.0", "v1.30.0", "v1.26.0-cli"];
    expect(previousTag("engine", tags)).toBe("v1.30.0");
    expect(previousTag("cli", ["v1.27.0-alpha.1-cli", "v1.28.0-cli"])).toBe("v1.28.0-cli");
  });

  // A beta is published too, so notes anchored before it would repeat what it already shipped.
  test("takes a beta released after the last alpha", () => {
    expect(previousTag("engine", ["v1.24.8-alpha.2", "v1.25.0-beta.1"])).toBe("v1.25.0-beta.1");
  });

  // Before any alpha exists the notes still need a lower bound, or they would span all history.
  test("falls back to the channel's highest stable tag", () => {
    expect(previousTag("cli", ["v1.25.0-cli", "v1.26.0-cli", "v1.24.7"])).toBe("v1.26.0-cli");
    expect(previousTag("engine", ["v1.24.6", "v1.24.7", "v1.26.0-cli"])).toBe("v1.24.7");
  });

  test("is undefined when the channel has no tag at all", () => {
    expect(previousTag("cli", ["v1.24.7"])).toBeUndefined();
  });
});

describe("the alpha tag step", () => {
  const workflow = readRepoFile(".github/workflows/release-alpha.yml");

  // Behaviour lives in tests/integration/alpha-tag.test.ts, which runs the script for real.
  test("the workflow passes the derived previous tag through env", () => {
    expect(workflow).toContain("PREVIOUS: ${{ needs.decide.outputs.previous }}");
    expect(workflow).toContain("run: .github/scripts/alpha-tag.sh");
  });
});
