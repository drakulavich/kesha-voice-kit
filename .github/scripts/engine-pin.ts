#!/usr/bin/env bun
/**
 * Derive the Engine a published CLI resolves and inject it into package.json as `kesha.engine`
 * (openspec unified-release D1): the version plus the SHA-256 of every asset the installer
 * downloads, read from that release's one SHA256SUMS. Never committed.
 *
 * Usage: bun .github/scripts/engine-pin.ts inject <SHA256SUMS> <engine-version>
 *        gh release list --json tagName,isDraft,isPrerelease | bun .github/scripts/engine-pin.ts newest-stable
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseSha256Sums, PINNED_ASSET_SHA256 } from "../../src/engine-targets";
import type { AssetPins } from "../../src/engine-install";
import { cmp, isSemver, parseSemver } from "../../src/semver.mjs";

export const PINNED_ASSETS = Object.keys(PINNED_ASSET_SHA256);

export function buildEnginePin(version: string, sha256Sums: string): AssetPins {
  if (!isSemver(version)) throw new Error(`refusing to pin a non-SemVer Engine version: ${version}`);
  const sums = parseSha256Sums(sha256Sums);
  const missing = PINNED_ASSETS.filter((name) => !sums.has(name));
  if (missing.length > 0) throw new Error(`SHA256SUMS of Engine v${version} does not list ${missing.join(", ")}`);
  return { version, sha256: Object.fromEntries(PINNED_ASSETS.map((name) => [name, sums.get(name)!])) };
}

export function withEnginePin(packageJson: string, pin: AssetPins): string {
  const pkg = JSON.parse(packageJson);
  return `${JSON.stringify({ ...pkg, kesha: { ...pkg.kesha, engine: pin } }, null, 2)}\n`;
}

type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean };

/** Highest by SemVer, not newest by date: a patch of an older line must not become the per-merge alpha's Engine. */
export function newestStableRelease(releases: Release[]): string {
  const stable = releases
    .filter((r) => !r.isDraft && !r.isPrerelease && /^v\d+\.\d+\.\d+$/.test(r.tagName))
    .map((r) => r.tagName.slice(1))
    .sort((a, b) => cmp(parseSemver(b, "release"), parseSemver(a, "release")));
  if (stable.length === 0) throw new Error("no published stable Engine release to resolve");
  return stable[0]!;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "inject" && args.length === 2) {
      const pin = buildEnginePin(args[1]!, readFileSync(args[0]!, "utf8"));
      writeFileSync("package.json", withEnginePin(readFileSync("package.json", "utf8"), pin));
      console.error(`package.json#kesha.engine pins Engine v${pin.version} (${PINNED_ASSETS.length} assets); not committed.`);
    } else if (command === "newest-stable" && args.length === 0) {
      process.stdout.write(`${newestStableRelease(JSON.parse(await Bun.stdin.text()))}\n`);
    } else {
      console.error("usage: engine-pin.ts inject <SHA256SUMS> <engine-version> | newest-stable < releases.json");
      process.exit(2);
    }
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
