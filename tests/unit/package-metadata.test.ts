import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageJson {
  files?: string[];
  scripts?: Record<string, string>;
}

const REPO_DIRS = ["tests/", "src/", "scripts/", ".github/"];

function repoPathsIn(script: string): string[] {
  return script
    .split(/\s+/)
    .filter((token) => !token.startsWith("-") && !token.includes("="))
    .filter((token) => REPO_DIRS.some((dir) => token.startsWith(dir)));
}

describe("package metadata", () => {
  test("publishes install-plan model metadata", () => {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;

    expect(pkg.files).toContain("model-plan.json");
  });

  test("does not publish lifecycle scripts", () => {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.cjs");
  });

  // `bun test` exits 0 on a filter that matches nothing whenever another one does.
  test("every repo path a script names still exists", () => {
    const repoRoot = new URL("../../", import.meta.url);
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("package.json", repoRoot)), "utf8"),
    ) as PackageJson;

    const missing = Object.entries(pkg.scripts ?? {}).flatMap(([name, script]) =>
      repoPathsIn(script)
        .filter((path) => !existsSync(fileURLToPath(new URL(path, repoRoot))))
        .map((path) => `${name}: ${path}`),
    );

    expect(missing).toEqual([]);
  });
});
