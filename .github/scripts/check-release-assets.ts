#!/usr/bin/env bun
/**
 * Refuse to publish a release directory that differs from its manifest: every named asset built,
 * nothing unnamed shipped, and every asset but SHA256SUMS itself listed in SHA256SUMS.
 *
 * Usage: bun .github/scripts/check-release-assets.ts <asset-dir>   (run before signing)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSha256Sums } from "../../src/engine-targets";

const SUMS = "SHA256SUMS";

export function assetProblems(manifest: { assets: Array<{ name: string }> }, files: string[], sha256Sums: string): string[] {
  const named = new Set(manifest.assets.map((asset) => asset.name));
  const present = new Set(files);
  const sums = parseSha256Sums(sha256Sums);
  return [
    ...[...named].filter((name) => !present.has(name)).map((name) => `${name} is in the manifest but was not built`),
    ...files.filter((name) => !named.has(name)).map((name) => `${name} would be published but is not in the manifest`),
    ...files.filter((name) => name !== SUMS && named.has(name) && !sums.has(name)).map((name) => `${name} is not listed in ${SUMS}`),
  ];
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun .github/scripts/check-release-assets.ts <asset-dir>");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "kesha-release-manifest.json"), "utf8"));
  const files = readdirSync(dir).filter((name) => !name.endsWith(".sigstore.json"));
  const problems = assetProblems(manifest, files, readFileSync(join(dir, SUMS), "utf8"));
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.error(`${files.length} release assets match the manifest and ${SUMS}.`);
}
