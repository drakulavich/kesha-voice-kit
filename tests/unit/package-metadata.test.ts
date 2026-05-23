import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface PackageJson {
  files?: string[];
  scripts?: Record<string, string>;
}

describe("package metadata", () => {
  test("does not publish lifecycle scripts", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.cjs");
  });
});
