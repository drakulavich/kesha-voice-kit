// The module stays .mjs so build-engine.yml can run it under node, like its siblings.
export function composeEngineReleaseNotes(tag: string, notes?: string, workflow?: "build-engine.yml" | "release.yml"): string;
