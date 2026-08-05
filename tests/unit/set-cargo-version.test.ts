import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { withCargoVersion } from "../../.github/scripts/set-cargo-version.mjs";

const MANIFEST = readFileSync(`${import.meta.dir}/../../rust/Cargo.toml`, "utf8");

describe("withCargoVersion", () => {
  test("replaces the [package] version", () => {
    expect(withCargoVersion(MANIFEST, "1.24.8-alpha.1")).toContain('version = "1.24.8-alpha.1"');
  });

  // The rewrite is a regex over a TOML file; a dependency pin is one `version = "…"` away.
  test("leaves dependency versions alone", () => {
    const before = MANIFEST.slice(MANIFEST.indexOf("\n[dependencies]"));
    const after = withCargoVersion(MANIFEST, "1.24.8-alpha.1");

    expect(after.slice(after.indexOf("\n[dependencies]"))).toBe(before);
  });

  test("rewrites exactly one line", () => {
    const original = MANIFEST.split("\n");
    const changed = withCargoVersion(MANIFEST, "1.24.8-alpha.1")
      .split("\n")
      .filter((line: string, i: number) => line !== original[i]);

    expect(changed).toEqual(['version = "1.24.8-alpha.1"']);
  });

  test("refuses a version that is not SemVer", () => {
    for (const bad of ["latest", "1.24", "v1.24.8", '1.24.8"\nname = "evil']) {
      expect(() => withCargoVersion(MANIFEST, bad)).toThrow(/non-SemVer/);
    }
  });

  test("refuses a manifest whose first table is not [package]", () => {
    expect(() => withCargoVersion('[workspace]\nversion = "1.0.0"\n', "1.24.8-alpha.1")).toThrow(
      /\[package\]/,
    );
  });

  test("refuses a [package] table with no version line", () => {
    expect(() => withCargoVersion('[package]\nname = "kesha-engine"\n', "1.24.8-alpha.1")).toThrow(
      /no version line/,
    );
  });
});
