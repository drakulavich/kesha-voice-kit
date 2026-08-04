import { describe, expect, test } from "bun:test";
import { withVersion } from "../../.github/scripts/set-package-version.mjs";

const PKG = JSON.stringify({ name: "kesha", version: "1.27.0", keshaEngine: { version: "1.24.7" } });

describe("withVersion", () => {
  test("replaces the top-level version and leaves the engine version alone", () => {
    const out = JSON.parse(withVersion(PKG, "1.27.0-alpha.3"));

    expect(out.version).toBe("1.27.0-alpha.3");
    expect(out.keshaEngine.version).toBe("1.24.7");
  });

  test("keeps the version field in place rather than reordering the file", () => {
    expect(Object.keys(JSON.parse(withVersion(PKG, "1.27.0-alpha.3")))).toEqual([
      "name",
      "version",
      "keshaEngine",
    ]);
  });

  test("ends with a newline, as package.json does", () => {
    expect(withVersion(PKG, "1.27.0-alpha.3").endsWith("}\n")).toBe(true);
  });

  test("refuses a version that is not SemVer", () => {
    for (const bad of ["latest", "1.27", "v1.27.0", "1.27.0 ; rm -rf /"]) {
      expect(() => withVersion(PKG, bad)).toThrow(/non-SemVer/);
    }
  });
});
