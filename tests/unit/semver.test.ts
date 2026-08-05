import { describe, expect, test } from "bun:test";
import { cmp, fmt, parseSemver } from "../../src/semver.mjs";

const v = (raw: string) => parseSemver(raw, "test");

describe("parseSemver (SemVer 2.0)", () => {
  test("splits the three numeric parts, the prerelease and the build metadata", () => {
    expect(v("1.24.8")).toEqual({ major: 1, minor: 24, patch: 8, prerelease: [], build: [] });
    expect(v("1.24.8-alpha.1")).toMatchObject({ prerelease: ["alpha", "1"], build: [] });
    expect(v("1.24.8-alpha.1+exp.sha.5114f85")).toMatchObject({
      prerelease: ["alpha", "1"],
      build: ["exp", "sha", "5114f85"],
    });
  });

  test("rejects what the spec rejects", () => {
    for (const raw of ["1.24", "v1.24.8", "01.2.3", "1.0.0-01", "1.0.0-..", "1.0.0-", "1.0.0+", "latest", ""]) {
      expect(() => v(raw)).toThrow(/not a valid SemVer 2\.0 version/);
    }
  });

  test("accepts the prerelease shapes the spec allows", () => {
    for (const raw of ["1.0.0-0", "1.0.0-alpha.0", "1.0.0-0.3.7", "1.0.0-x-y-z.-", "1.0.0-rc.1+build.1"]) {
      expect(() => v(raw)).not.toThrow();
    }
  });
});

describe("cmp", () => {
  test("orders by major, minor, then patch", () => {
    expect(cmp(v("2.0.0"), v("1.9.9"))).toBeGreaterThan(0);
    expect(cmp(v("1.2.0"), v("1.10.0"))).toBeLessThan(0);
    expect(cmp(v("1.2.3"), v("1.2.3"))).toBe(0);
  });

  test("a stable version outranks its own prereleases", () => {
    expect(cmp(v("1.0.0"), v("1.0.0-alpha.1"))).toBeGreaterThan(0);
    expect(cmp(v("1.0.0-alpha.1"), v("1.0.0-beta.1"))).toBeLessThan(0);
    expect(cmp(v("1.0.0-alpha.2"), v("1.0.0-alpha.10"))).toBeLessThan(0);
    expect(cmp(v("1.0.0-alpha"), v("1.0.0-alpha.1"))).toBeLessThan(0);
  });

  // SemVer §10, and the reason `fmt` keeps build metadata while `cmp` drops it.
  test("build metadata does not affect precedence", () => {
    expect(cmp(v("1.0.0+build.1"), v("1.0.0+build.2"))).toBe(0);
    expect(cmp(v("1.0.0+build.1"), v("1.0.0"))).toBe(0);
  });
});

describe("fmt", () => {
  test("round-trips every part it parsed", () => {
    for (const raw of ["1.24.8", "1.24.8-alpha.1", "1.24.8-rc.1+build.9"]) {
      expect(fmt(v(raw))).toBe(raw);
    }
  });
});
