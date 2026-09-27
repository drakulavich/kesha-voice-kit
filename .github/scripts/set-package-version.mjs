#!/usr/bin/env node
/**
 * Write a version into package.json without committing it.
 *
 * Prerelease versions are derived at publish time, so they never live in a commit;
 * release.yml applies one after checkout (#685). Rewrites only the top-level `version`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { entryArg } from "./script-entry.mjs";
import { isSemver } from "../../src/semver.mjs";

export function withVersion(packageJson, version) {
  if (!isSemver(version)) {
    throw new Error(`refusing to write a non-SemVer version into package.json: ${version}`);
  }
  const pkg = JSON.parse(packageJson);
  if (typeof pkg.version !== "string") {
    throw new Error("package.json has no top-level version string to replace");
  }
  return `${JSON.stringify({ ...pkg, version }, null, 2)}\n`;
}

const version = entryArg(import.meta.url, "usage: node .github/scripts/set-package-version.mjs <version>");
if (version) {
  writeFileSync("package.json", withVersion(readFileSync("package.json", "utf8"), version));
}
