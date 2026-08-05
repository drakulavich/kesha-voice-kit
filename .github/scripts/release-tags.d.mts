// The module stays .mjs because build-engine.yml runs release-manifest.mjs under node.
export const ENGINE_TAG_ERE: string;
export const ENGINE_TAG_RE: RegExp;
export const STABLE_TAG_RE: RegExp;
export function isStableTag(tag: string): boolean;
export function cliPublishTarget(tag: string): {
  version: string;
  engineOnly: boolean;
  derived: boolean;
};
