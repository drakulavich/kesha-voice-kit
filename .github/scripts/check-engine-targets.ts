#!/usr/bin/env bun
/**
 * Verifies every `ENGINE_TARGETS` row against the published release.
 *
 * Centralising the table removed the duplication but not the drift: the sizes are
 * hand-written and only feed `kesha install --plan`, so a wrong one misleads a user
 * about disk cost and nothing fails. `install-plan.ts` carried a stale 63_126_528
 * against an actual 63_447_040 for exactly that reason (#216).
 *
 * Skips (exit 0) when the release is unreachable — offline dev and forked PRs
 * without a token must not fail on network, only on a real mismatch.
 */
import { engineTarget, engineTargetKeys } from "../../src/engine-targets";
import { engineVersion } from "../../src/package-info";

const REPO = "drakulavich/kesha-voice-kit";
const url = `https://api.github.com/repos/${REPO}/releases/tags/v${engineVersion}`;

const headers: Record<string, string> = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

let assets: Array<{ name: string; size: number }>;
try {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.log(`skip: release v${engineVersion} unreachable (HTTP ${res.status})`);
    process.exit(0);
  }
  assets = (await res.json()).assets ?? [];
} catch (e) {
  console.log(`skip: could not reach the release API (${e instanceof Error ? e.message : e})`);
  process.exit(0);
}

const bySize = new Map(assets.map((a) => [a.name, a.size]));
const problems: string[] = [];

for (const key of engineTargetKeys()) {
  const [platform, arch] = key.split("-");
  const target = engineTarget(platform, arch)!;
  const published = bySize.get(target.assetName);

  if (published === undefined) {
    problems.push(
      `${key}: release v${engineVersion} has no asset named ${target.assetName}` +
        ` (published: ${assets.map((a) => a.name).join(", ") || "none"})`,
    );
    continue;
  }
  if (published !== target.sizeBytes) {
    problems.push(
      `${key}: ${target.assetName} is ${published} bytes in v${engineVersion}, ` +
        `but ENGINE_TARGETS says ${target.sizeBytes}`,
    );
    continue;
  }
  console.log(`ok: ${key} → ${target.assetName} (${published} bytes)`);
}

if (problems.length > 0) {
  console.error(`\nENGINE_TARGETS is out of date with release v${engineVersion}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n  Fix: update src/engine-targets.ts to match the published assets.`);
  process.exit(1);
}
