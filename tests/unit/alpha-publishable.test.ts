import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { publishableChanges, shippedPrefixes } from "../../.github/scripts/alpha-publishable";

const FILES = ["bin/", "src/", "package.json", "README.md"];

describe("publishableChanges", () => {
  test("a change inside a shipped directory publishes", () => {
    expect(publishableChanges(["src/cli/init.ts"], FILES)).toEqual(["src/cli/init.ts"]);
  });

  test("a shipped file itself publishes", () => {
    expect(publishableChanges(["package.json"], FILES)).toEqual(["package.json"]);
  });

  test("repo tooling and docs that do not ship publish nothing", () => {
    const changed = [".github/workflows/ci.yml", "tests/unit/init.test.ts", "rust/src/models.rs"];

    expect(publishableChanges(changed, FILES)).toEqual([]);
  });

  // `src/` must not match `srcery/` — the prefix is a directory, not a string fragment.
  test("a sibling path that merely starts with a shipped name does not publish", () => {
    expect(publishableChanges(["srcery/x.ts", "binary/y"], FILES)).toEqual([]);
  });

  test("reports every matching path, not just the first", () => {
    expect(publishableChanges(["src/a.ts", "docs/x.md", "bin/kesha.js"], FILES)).toEqual([
      "src/a.ts",
      "bin/kesha.js",
    ]);
  });

  test("trailing slashes in package.json#files are normalised", () => {
    expect(shippedPrefixes(["bin/", "src/", "README.md"])).toEqual(["bin", "src", "README.md"]);
  });
});

describe("against the real package", () => {
  const files = JSON.parse(readFileSync(`${import.meta.dir}/../../package.json`, "utf8")).files;

  test("package.json still declares what ships", () => {
    expect(Array.isArray(files) && files.length > 0).toBe(true);
  });

  test("a CLI source change publishes; a workflow change does not", () => {
    expect(publishableChanges(["src/engine.ts"], files)).toEqual(["src/engine.ts"]);
    expect(publishableChanges([".github/workflows/release-alpha.yml"], files)).toEqual([]);
  });
});
