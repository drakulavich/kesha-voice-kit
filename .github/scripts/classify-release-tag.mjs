#!/usr/bin/env node
/**
 * Decide how a release tag is published: Prerelease or not, and whether the build publishes
 * the draft itself.
 *
 * Every release is *created* as a draft regardless — this repository has GitHub immutable
 * releases enabled, and an asset uploaded after publication fails with 422 "Cannot upload
 * asset to an immutable release". Stable and beta then wait for the human un-draft gate that
 * validates the binaries; an alpha is dispatched on purpose and must be installable the
 * moment the build finishes (#685), so the workflow un-drafts it in a later step.
 * Prints `publish=`/`prerelease=` lines suitable for `$GITHUB_OUTPUT`.
 */
import { pathToFileURL } from "node:url";
import { isEngineAlphaTag, isStableTag } from "./release-tags.mjs";

export function classifyReleaseTag(tag) {
  return { publish: isEngineAlphaTag(tag), prerelease: !isStableTag(tag) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: node .github/scripts/classify-release-tag.mjs <tag>");
    process.exit(2);
  }
  const kind = classifyReleaseTag(tag);
  process.stdout.write(`publish=${kind.publish}\nprerelease=${kind.prerelease}\n`);
}
