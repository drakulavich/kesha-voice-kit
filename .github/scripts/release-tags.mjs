/**
 * One home for the release tag grammar.
 *
 * The shape is declared as a POSIX ERE *string* so bash `=~` in build-engine.yml and
 * JavaScript `RegExp` can consume the identical text — `release-manifest.mjs` pins the
 * workflow to it, which is what keeps the two languages from drifting (#685).
 */

import { pathToFileURL } from "node:url";

/** Engine tags: `vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-alpha.N`. CLI marker tags end in `-cli`. */
export const ENGINE_TAG_ERE = "^v[0-9]+\\.[0-9]+\\.[0-9]+(-(beta|alpha)\\.[0-9]+)?$";

export const ENGINE_TAG_RE = new RegExp(ENGINE_TAG_ERE);
export const STABLE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

export function isStableTag(tag) {
  return STABLE_TAG_RE.test(tag);
}

const CLI_MARKER = "-cli";

/**
 * What the CLI publish path should do with a release tag.
 *
 * An engine prerelease publishes no CLI: reacting to it would compare an engine version
 * against `package.json#version` and fail a workflow nobody asked to run (#685).
 */
export function cliPublishTarget(tag) {
  const cliMarked = tag.endsWith(CLI_MARKER);
  const base = cliMarked ? tag.slice(0, -CLI_MARKER.length) : tag;
  return {
    version: base.replace(/^v/, ""),
    engineOnly: !cliMarked && base.includes("-"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: node .github/scripts/release-tags.mjs <tag>");
    process.exit(2);
  }
  const target = cliPublishTarget(tag);
  process.stdout.write(`version=${target.version}\nengine_only=${target.engineOnly}\n`);
}
