import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { withCargoVersion } from "../../.github/scripts/set-cargo-version.mjs";

// Normalised, not inherited: a Windows checkout carries CRLF and would double it below.
const MANIFEST = readFileSync(`${import.meta.dir}/../../rust/Cargo.toml`, "utf8").replace(
  /\r\n/g,
  "\n",
);
const CRLF_MANIFEST = MANIFEST.replace(/\n/g, "\r\n");

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

  // The runner rewrites whatever git checked out, and on Windows that is CRLF.
  test("a CRLF manifest keeps its line endings", () => {
    const out = withCargoVersion(CRLF_MANIFEST, "1.24.8-alpha.1");

    expect(out).toContain('version = "1.24.8-alpha.1"\r\n');
    expect(out.match(/(?<!\r)\n/)).toBeNull();
    expect(out.replace(/\r\n/g, "\n")).toBe(withCargoVersion(MANIFEST, "1.24.8-alpha.1"));
  });

  test("refuses a version that is not SemVer", () => {
    for (const bad of ["latest", "1.24", "v1.24.8", '1.24.8"\nname = "evil']) {
      expect(() => withCargoVersion(MANIFEST, bad)).toThrow(/non-SemVer/);
    }
  });

  // Valid TOML the rewrite must survive: failing here burns a tag the tag job already pushed.
  test.each([
    ['# header\n[package]\nversion = "1.0.0"\n', 'version = "1.24.8-alpha.1"'],
    ['[package]\nversion = "1.0.0" # pinned\n', 'version = "1.24.8-alpha.1" # pinned'],
    ["[package]\nversion = '1.0.0'\n", 'version = "1.24.8-alpha.1"'],
    ['[package]\nversion="1.0.0"\n', 'version="1.24.8-alpha.1"'],
    ['[package] # the crate\nversion = "1.0.0"\n', 'version = "1.24.8-alpha.1"'],
  ])("rewrites %j", (source, expected) => {
    expect(withCargoVersion(source, "1.24.8-alpha.1")).toContain(expected);
  });

  test("takes the version from [package], not from a table that precedes it", () => {
    const out = withCargoVersion(
      '[workspace.package]\nversion = "0.0.1"\n\n[package]\nversion = "1.0.0"\n',
      "1.24.8-alpha.1",
    );

    expect(out).toContain('[workspace.package]\nversion = "0.0.1"');
    expect(out).toContain('[package]\nversion = "1.24.8-alpha.1"');
  });

  test("refuses a manifest with no [package] table", () => {
    expect(() => withCargoVersion('[workspace]\nversion = "1.0.0"\n', "1.24.8-alpha.1")).toThrow(
      /no \[package\] table/,
    );
  });

  test("refuses a [package] table with no version line", () => {
    expect(() => withCargoVersion('[package]\nname = "kesha-engine"\n', "1.24.8-alpha.1")).toThrow(
      /no version line/,
    );
  });
});
