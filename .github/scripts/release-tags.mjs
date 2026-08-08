/**
 * One home for the release tag grammar.
 *
 * The shape is declared as a POSIX ERE *string* so bash `=~` in build-engine.yml and
 * JavaScript `RegExp` can consume the identical text — `release-manifest.mjs` pins the
 * workflow to it, which is what keeps the two languages from drifting (#685).
 */

import { pathToFileURL } from "node:url";

const VERSION_ERE = "[0-9]+\\.[0-9]+\\.[0-9]+(-(beta|alpha)\\.[0-9]+)?";

/** Engine tags: `vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-alpha.N`. CLI marker tags end in `-cli`. */
export const ENGINE_TAG_ERE = `^v${VERSION_ERE}$`;

export const ENGINE_TAG_RE = new RegExp(ENGINE_TAG_ERE);
export const STABLE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
export const ALPHA_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/;

export const CLI_MARKER = "-cli";

/** The same version shapes as an engine tag, carrying the marker that makes them the CLI's. */
export const CLI_TAG_RE = new RegExp(`^v${VERSION_ERE}${CLI_MARKER}$`);

export function isStableTag(tag) {
  return STABLE_TAG_RE.test(tag);
}

/** Engine alphas only. A CLI alpha ends in `-cli` and never reaches an engine-side validator. */
export function isEngineAlphaTag(tag) {
  return ALPHA_TAG_RE.test(tag);
}

/** Every shape a channel has already published, so notes can be anchored at the latest one. */
export function publishedVersionRe(marker) {
  return new RegExp(`^v([0-9]+\\.[0-9]+\\.[0-9]+(?:-(?:alpha|beta)\\.[0-9]+)?)${marker}$`);
}

/**
 * What the CLI publish path should do with a release tag.
 *
 * No engine tag publishes a CLI. Since #691 a bare tag names the engine version only, so
 * reacting to one would publish `main`'s CLI under the engine's number and drag npm's
 * `latest` backwards; the CLI ships from its own `-cli` marker tag instead (#729).
 */
export function cliPublishTarget(tag) {
  const cliMarked = tag.endsWith(CLI_MARKER);
  const base = cliMarked ? tag.slice(0, -CLI_MARKER.length) : tag;
  const version = base.replace(/^v/, "");
  return {
    version,
    engineOnly: !cliMarked,
    // An alpha version is minted at publish time, so no commit carries it to verify against.
    derived: version.includes("-alpha."),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: node .github/scripts/release-tags.mjs <tag>");
    process.exit(2);
  }
  const target = cliPublishTarget(tag);
  process.stdout.write(
    `version=${target.version}\nengine_only=${target.engineOnly}\nderived=${target.derived}\n`,
  );
}
