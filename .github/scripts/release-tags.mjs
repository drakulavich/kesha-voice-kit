/** One home for the release tag grammar: `vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-alpha.N` (#685). */

export const ENGINE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(-(beta|alpha)\.[0-9]+)?$/;
const STABLE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const ALPHA_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/;

export function isStableTag(tag) {
  return STABLE_TAG_RE.test(tag);
}

export function isEngineAlphaTag(tag) {
  return ALPHA_TAG_RE.test(tag);
}
