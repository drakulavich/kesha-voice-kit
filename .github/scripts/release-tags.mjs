/**
 * One home for the release tag grammar.
 *
 * The shape is declared as a POSIX ERE *string* so bash `=~` in build-engine.yml and
 * JavaScript `RegExp` can consume the identical text — `release-manifest.mjs` pins the
 * workflow to it, which is what keeps the two languages from drifting (#685).
 */

/** Engine tags: `vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-alpha.N`. CLI marker tags end in `-cli`. */
export const ENGINE_TAG_ERE = "^v[0-9]+\\.[0-9]+\\.[0-9]+(-(beta|alpha)\\.[0-9]+)?$";

export const ENGINE_TAG_RE = new RegExp(ENGINE_TAG_ERE);
export const STABLE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

export function isStableTag(tag) {
  return STABLE_TAG_RE.test(tag);
}

/**
 * Which version field an engine tag must equal, and what to call it in an error.
 *
 * Stable tags also name the Linux packages, whose filenames come from the CLI version;
 * a prerelease builds none, so it answers to the engine version the manifest describes.
 */
export function expectedTagVersion(tag, { cliVersion, engineVersion }) {
  return isStableTag(tag)
    ? { field: "package.json#version", version: cliVersion }
    : { field: "package.json#keshaEngine.version", version: engineVersion };
}
