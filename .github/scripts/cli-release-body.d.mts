// The module stays .mjs so release-cli.yml can run it under node, like its siblings.
export function previousStableCliTag(tag: string, tags: string[]): string | undefined;
export function composeCliReleaseBody(parts: {
  version: string;
  engineVersion: string;
  previousEngineVersion?: string;
  notes?: string;
}): string;
