#!/usr/bin/env node
/**
 * Decide how a release tag is published: draft or live, release or Prerelease.
 *
 * Stable and beta tags stay drafts because un-drafting is the human gate that validates the
 * binaries before anyone can download them. An alpha has no such gate — it is dispatched on
 * purpose and must be installable the moment the build finishes (#685), so it publishes live.
 * Prints `draft=`/`prerelease=` lines suitable for `$GITHUB_OUTPUT`.
 */
import { pathToFileURL } from "node:url";
import { isEngineAlphaTag, isStableTag } from "./release-tags.mjs";

export function classifyReleaseTag(tag) {
  return { draft: !isEngineAlphaTag(tag), prerelease: !isStableTag(tag) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: node .github/scripts/classify-release-tag.mjs <tag>");
    process.exit(2);
  }
  const kind = classifyReleaseTag(tag);
  process.stdout.write(`draft=${kind.draft}\nprerelease=${kind.prerelease}\n`);
}
