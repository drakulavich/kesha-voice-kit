#!/usr/bin/env bun
/**
 * Verifies that the newest stable release publishes every asset the installer downloads, under the
 * names `src/engine-targets.ts` gives them. A renamed or missing asset would otherwise surface only
 * when `release.yml` refuses to inject the Engine pin, or when a user's install 404s.
 *
 * Hashes and sizes are not committed any more: `engine-pin.ts` injects them at publish (openspec
 * unified-release D1).
 */
import { downloadedAssetNames } from "../../src/engine-targets";
import { newestStableRelease } from "./engine-pin";

const REPO = "drakulavich/kesha-voice-kit";

type ApiRelease = { tag_name: string; draft: boolean; prerelease: boolean; assets: Array<{ name: string }> };

const headers: Record<string, string> = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

// Every page: alpha Prereleases can push the newest stable release past the first hundred.
const releases: ApiRelease[] = [];
try {
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) {
      // A token means CI, where the API is reachable — skipping there would hide real drift.
      if (process.env.GITHUB_TOKEN) {
        console.error(`FAIL: release API returned HTTP ${res.status}`);
        process.exit(1);
      }
      console.log(`skip: release API returned HTTP ${res.status}`);
      process.exit(0);
    }
    const batch: ApiRelease[] = await res.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
} catch (e) {
  console.log(`skip: could not reach the release API (${e instanceof Error ? e.message : e})`);
  process.exit(0);
}

const version = newestStableRelease(
  releases.map((r) => ({ tagName: r.tag_name, isDraft: r.draft, isPrerelease: r.prerelease })),
);
const published = new Set(releases.find((r) => r.tag_name === `v${version}`)!.assets.map((a) => a.name));
const missing = downloadedAssetNames().filter((name) => !published.has(name));

if (missing.length > 0) {
  console.error(`FAIL: release v${version} publishes no asset named ${missing.join(", ")}`);
  console.error(`  published: ${[...published].sort().join(", ") || "none"}`);
  console.error("  Fix: correct the asset names in src/engine-targets.ts, or the release that builds them.");
  process.exit(1);
}
console.log(`ok: release v${version} publishes ${downloadedAssetNames().join(", ")}`);
