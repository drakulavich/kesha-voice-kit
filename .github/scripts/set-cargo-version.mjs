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
import { pathToFileURL } from "node:url";
import { isSemver } from "../../src/semver.mjs";

const MANIFEST = "rust/Cargo.toml";

export function withCargoVersion(manifest, version) {
  if (!isSemver(version)) {
    throw new Error(`refusing to write a non-SemVer version into Cargo.toml: ${version}`);
  }
  if (!manifest.startsWith("[package]")) {
    throw new Error("Cargo.toml must open with [package] for the version rewrite to be unambiguous");
  }

  const end = manifest.indexOf("\n[", 1);
  const head = end === -1 ? manifest : manifest.slice(0, end);
  const tail = end === -1 ? "" : manifest.slice(end);
  const rewritten = head.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
  if (rewritten === head) {
    throw new Error("[package] has no version line to replace");
  }

  return rewritten + tail;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node .github/scripts/set-cargo-version.mjs <version>");
    process.exit(2);
  }
  writeFileSync(MANIFEST, withCargoVersion(readFileSync(MANIFEST, "utf8"), version));
}
