// The module stays .mjs because build-engine.yml runs release-manifest.mjs under node.
export const ENGINE_TAG_ERE: string;
export const ENGINE_TAG_RE: RegExp;
export const STABLE_TAG_RE: RegExp;
export const ALPHA_TAG_RE: RegExp;
export function isStableTag(tag: string): boolean;
export function isEngineAlphaTag(tag: string): boolean;
export const CLI_MARKER: string;
export function publishedVersionRe(marker: string): RegExp;
export function cliPublishTarget(tag: string): {
  version: string;
  engineOnly: boolean;
  derived: boolean;
};
