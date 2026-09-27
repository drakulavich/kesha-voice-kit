#!/usr/bin/env bun
/**
 * Derive the Engine a published CLI resolves and inject it into package.json as `kesha.engine`
 * (openspec unified-release D1): the version plus the SHA-256 of every asset the installer
 * downloads and its size, read from that release's one SHA256SUMS and its asset list
 * (`[{ name, size }]`, the shape of `gh release view --json assets`). Never committed.
 *
 * Usage: bun .github/scripts/engine-pin.ts inject <dir holding SHA256SUMS and assets.json> <engine-version>
 *        bun .github/scripts/engine-pin.ts asset-sizes <release-assets dir> > assets.json
 *        gh release list --json tagName,isDraft,isPrerelease | bun .github/scripts/engine-pin.ts newest-stable
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadedAssetNames, parseSha256Sums } from "../../src/engine-targets";
import type { AssetPins } from "../../src/engine-install";
import { cmp, isSemver, parseSemver } from "../../src/semver.mjs";

export const PINNED_ASSETS = downloadedAssetNames();

type Asset = { name: string; size: number };

export function buildEnginePin(version: string, sha256Sums: string, assets: Asset[]): AssetPins {
  if (!isSemver(version)) throw new Error(`refusing to pin a non-SemVer Engine version: ${version}`);
  const sums = parseSha256Sums(sha256Sums);
  const missing = PINNED_ASSETS.filter((name) => !sums.has(name));
  if (missing.length > 0) throw new Error(`SHA256SUMS of Engine v${version} does not list ${missing.join(", ")}`);
  const sizes = new Map(assets.map((a) => [a.name, a.size]));
  const unsized = PINNED_ASSETS.filter((name) => !(Number.isSafeInteger(sizes.get(name)) && sizes.get(name)! > 0));
  if (unsized.length > 0) throw new Error(`the asset list of Engine v${version} gives no size for ${unsized.join(", ")}`);
  return {
    version,
    sha256: Object.fromEntries(PINNED_ASSETS.map((name) => [name, sums.get(name)!])),
    size: Object.fromEntries(PINNED_ASSETS.map((name) => [name, sizes.get(name)!])),
  };
}

/** The asset list of an assembled release directory, in the shape `gh release view --json assets` gives a published one. */
export function assetSizes(dir: string): Asset[] {
  return readdirSync(dir)
    .map((name) => ({ name, stat: statSync(join(dir, name)) }))
    .filter(({ stat }) => stat.isFile())
    .map(({ name, stat }) => ({ name, size: stat.size }));
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
      const [dir, version] = args as [string, string];
      const assets = JSON.parse(readFileSync(join(dir, "assets.json"), "utf8"));
      const pin = buildEnginePin(version, readFileSync(join(dir, "SHA256SUMS"), "utf8"), assets);
      writeFileSync("package.json", withEnginePin(readFileSync("package.json", "utf8"), pin));
      console.error(`package.json#kesha.engine pins Engine v${pin.version} (${PINNED_ASSETS.length} assets); not committed.`);
    } else if (command === "asset-sizes" && args.length === 1) {
      process.stdout.write(`${JSON.stringify(assetSizes(args[0]!))}\n`);
    } else if (command === "newest-stable" && args.length === 0) {
      process.stdout.write(`${newestStableRelease(JSON.parse(await Bun.stdin.text()))}\n`);
    } else {
      console.error("usage: engine-pin.ts inject <dir> <engine-version> | asset-sizes <dir> | newest-stable < releases.json");
      process.exit(2);
    }
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
