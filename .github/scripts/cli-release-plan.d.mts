// The module stays .mjs so release-cli.yml can run it under node, like its siblings.
export function planCliRelease(
  tag: string,
  pkg: unknown,
): { version: string; packages: boolean; engineVersion?: string };
