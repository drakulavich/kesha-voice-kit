#!/usr/bin/env node
/**
 * Write a version into `rust/Cargo.toml` without committing it.
 *
 * An engine alpha is published ahead of the pin, so no commit carries its version — but
 * `kesha-engine --version` reports `CARGO_PKG_VERSION`, and a binary that names the pinned
 * release is indistinguishable from the stable build it is meant to be tested against (#685).
 * The build applies the tag's version in the runner, mirroring what
 * `set-package-version.mjs` does for the CLI tarball.
 *
 * Rewrites only the `version` of the `[package]` table; dependency versions are left alone.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { entryArg } from "./script-entry.mjs";
import { isSemver } from "../../src/semver.mjs";

const MANIFEST = "rust/Cargo.toml";

const PACKAGE_TABLE = /^\[package\][^\S\r\n]*(#.*)?$/m;
/** Only the value is replaced, so a trailing comment and the line's ending survive untouched. */
const VERSION_LINE = /^(version[^\S\r\n]*=[^\S\r\n]*)("[^"]*"|'[^']*')/m;

export function withCargoVersion(manifest, version) {
  if (!isSemver(version)) {
    throw new Error(`refusing to write a non-SemVer version into Cargo.toml: ${version}`);
  }

  const header = PACKAGE_TABLE.exec(manifest);
  if (!header) {
    throw new Error("Cargo.toml has no [package] table to take a version from");
  }

  const start = header.index + header[0].length;
  const offset = manifest.slice(start).search(/^\[/m);
  const end = offset === -1 ? manifest.length : start + offset;
  const table = manifest.slice(start, end);
  const rewritten = table.replace(VERSION_LINE, `$1"${version}"`);
  if (rewritten === table) {
    throw new Error("[package] has no version line to replace");
  }

  return manifest.slice(0, start) + rewritten + manifest.slice(end);
}

const version = entryArg(import.meta.url, "usage: node .github/scripts/set-cargo-version.mjs <version>");
if (version) {
  writeFileSync(MANIFEST, withCargoVersion(readFileSync(MANIFEST, "utf8"), version));
}
