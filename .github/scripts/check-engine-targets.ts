#!/usr/bin/env bun
/**
 * Verifies every `ENGINE_TARGETS` row and every `PINNED_ASSET_SHA256` entry against the published release.
 *
 * Centralising the table removed the duplication but not the drift: the sizes are
 * hand-written and only feed `kesha install --plan`, so a wrong one misleads a user
 * about disk cost and nothing fails. `install-plan.ts` carried a stale 63_126_528
 * against an actual 63_447_040 for exactly that reason (#216).
 *
 * Releases here merge first and tag second, so keshaEngine.version legitimately points at an
 * unpublished tag on a `release/*` PR and on the `chore(release):` push to main that follows.
 * A 404 anywhere else means the pinned version was never published, which is a real problem —
 * skipping it would make this check vacuous exactly when it matters.
 */
import { engineTargetEntries, parseSha256Sums, PINNED_ASSET_SHA256 } from "../../src/engine-targets";
import { engineVersion } from "../../src/package-info";

const REPO = "drakulavich/kesha-voice-kit";
const url = `https://api.github.com/repos/${REPO}/releases/tags/v${engineVersion}`;

const headers: Record<string, string> = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

let assets: Array<{ name: string; size: number; browser_download_url: string }>;
try {
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    const headRef = process.env.GITHUB_HEAD_REF ?? "";
    const headCommit = process.env.HEAD_COMMIT_MESSAGE ?? "";
    const midRelease =
      headRef.startsWith("release/") || headCommit.startsWith("chore(release):");
    if (midRelease) {
      console.log(
        `skip: v${engineVersion} is not published yet, which is expected between the release ` +
          `merge and its tag. The scheduled run verifies the sizes once the release exists.`,
      );
      process.exit(0);
    }
    console.error(
      `FAIL: package.json pins engine v${engineVersion}, but no such release exists.\n` +
        `  Fix: publish it, or correct keshaEngine.version.`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    // A token means CI, where the API is reachable — skipping there would hide real drift.
    if (process.env.GITHUB_TOKEN) {
      console.error(`FAIL: release API returned HTTP ${res.status} for v${engineVersion}`);
      process.exit(1);
    }
    console.log(`skip: release API returned HTTP ${res.status}`);
    process.exit(0);
  }
  assets = (await res.json()).assets ?? [];
} catch (e) {
  console.log(`skip: could not reach the release API (${e instanceof Error ? e.message : e})`);
  process.exit(0);
}

const bySize = new Map(assets.map((a) => [a.name, a.size]));
const problems: string[] = [];

for (const { platform, arch, target } of engineTargetEntries()) {
  const key = `${platform}-${arch}`;
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

const sumsAsset = assets.find((a) => a.name === "SHA256SUMS");
let sums: Map<string, string> | null = null;
if (!sumsAsset) {
  problems.push(`release v${engineVersion} has no SHA256SUMS asset, so no pinned SHA-256 can be checked`);
} else {
  try {
    const res = await fetch(sumsAsset.browser_download_url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sums = parseSha256Sums(await res.text());
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (process.env.GITHUB_TOKEN) problems.push(`could not download SHA256SUMS of v${engineVersion} (${why})`);
    else console.log(`skip: could not download SHA256SUMS (${why})`);
  }
}
for (const [assetName, pinned] of Object.entries(sums ? PINNED_ASSET_SHA256 : {})) {
  const published = sums!.get(assetName);
  if (published === undefined) {
    problems.push(`SHA256SUMS of v${engineVersion} does not list ${assetName}`);
  } else if (published !== pinned) {
    problems.push(`${assetName} is sha256 ${published} in v${engineVersion}, but PINNED_ASSET_SHA256 says ${pinned}`);
  } else {
    console.log(`ok: ${assetName} sha256 ${published}`);
  }
}

if (problems.length > 0) {
  console.error(`\nENGINE_TARGETS is out of date with release v${engineVersion}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n  Fix: update src/engine-targets.ts to match the published assets (sizes from the release API, SHA-256 from its SHA256SUMS).`);
  process.exit(1);
}
