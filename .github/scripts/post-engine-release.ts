#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { engineTargetEntries } from "../../src/engine-targets";
import { cmp, isStableVersion, parseSemver } from "../../src/semver.mjs";

const REPO = "drakulavich/kesha-voice-kit";

export type ReleaseAsset = { name: string; size: number; browser_download_url?: string };

type Release = {
  isDraft: boolean;
  isPrerelease: boolean;
  assets: ReleaseAsset[];
};

type Manifest = {
  tag: string;
  engineVersion: string;
  assets: Array<{ name: string; signatureBundle: string }>;
};

type FollowupInput = {
  tag: string;
  cliReleasePublished: boolean;
  release: Release;
  manifest: Manifest;
  targetSource: string;
  packageSource: string;
  serverSource: string;
};

export type Followup = {
  nextCliVersion: string;
  targetSource: string;
  packageSource: string;
  serverSource: string;
  prBody: string;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function booleanAt(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function parseManifest(value: unknown): Manifest {
  const raw = asRecord(value, "release manifest");
  if (!Array.isArray(raw.assets)) throw new Error("release manifest assets must be an array");
  return {
    tag: stringAt(raw.tag, "release manifest tag"),
    engineVersion: stringAt(raw.engineVersion, "release manifest engineVersion"),
    assets: raw.assets.map((entry) => {
      const asset = asRecord(entry, "release manifest asset");
      return {
        name: stringAt(asset.name, "release manifest asset name"),
        signatureBundle: stringAt(asset.signatureBundle, "release manifest asset signatureBundle"),
      };
    }),
  };
}

function assetMap(assets: ReleaseAsset[]): Map<string, ReleaseAsset> {
  const byName = new Map<string, ReleaseAsset>();
  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error("release assets must have unique names and positive integer sizes");
    }
    if (byName.has(asset.name)) throw new Error(`release has duplicate asset ${asset.name}`);
    byName.set(asset.name, asset);
  }
  return byName;
}

function requireSignedAssets(manifest: Manifest, releaseAssets: Map<string, ReleaseAsset>): void {
  const manifestNames = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.name !== "string" || typeof asset.signatureBundle !== "string") {
      throw new Error("release manifest has an invalid asset entry");
    }
    if (manifestNames.has(asset.name)) throw new Error(`release manifest has duplicate asset ${asset.name}`);
    manifestNames.add(asset.name);
    if (!releaseAssets.has(asset.name) || !releaseAssets.has(asset.signatureBundle)) {
      throw new Error(`release is missing signed asset ${asset.name} (${asset.signatureBundle})`);
    }
  }
}

function replaceTargetSize(source: string, assetName: string, size: number): string {
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(assetName:\\s*"${escaped}",\\s*\\n\\s*backend:\\s*"[^"]+",\\s*\\n\\s*sizeBytes:\\s*)\\d[\\d_]*`,
    "g",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`src/engine-targets.ts must contain exactly one editable row for ${assetName}`);
  }
  return source.replace(pattern, `$1${size.toLocaleString("en-US").replaceAll(",", "_")}`);
}

function parsePackage(source: string): { version: string; keshaEngine: { version: string } } {
  const pkg = asRecord(JSON.parse(source), "package.json");
  const engine = asRecord(pkg.keshaEngine, "package.json#keshaEngine");
  return {
    version: stringAt(pkg.version, "package.json#version"),
    keshaEngine: { version: stringAt(engine.version, "package.json#keshaEngine.version") },
  };
}

function replaceServerVersions(source: string, currentCliVersion: string, version: string): string {
  const server = asRecord(JSON.parse(source), "server.json");
  const current = stringAt(server.version, "server.json#version");
  if (current !== currentCliVersion) {
    throw new Error(`server.json#version (${current}) does not match package.json#version (${currentCliVersion})`);
  }
  const packages = server.packages;
  if (!Array.isArray(packages) || packages.length === 0) throw new Error("server.json#packages must be a non-empty array");
  for (const [index, entry] of packages.entries()) {
    const pkg = asRecord(entry, `server.json#packages[${index}]`);
    if (stringAt(pkg.version, `server.json#packages[${index}].version`) !== current) {
      throw new Error("server.json package versions must match server.json#version before a release follow-up");
    }
    pkg.version = version;
  }
  server.version = version;
  return `${JSON.stringify(server, null, 2)}\n`;
}

function formatProvenance(tag: string, nextCliVersion: string, releaseAssets: Map<string, ReleaseAsset>): string {
  const lines = engineTargetEntries().map(({ target }) => {
    const size = releaseAssets.get(target.assetName)?.size;
    if (size === undefined) throw new Error(`release is missing engine asset ${target.assetName}`);
    return `- \`${target.assetName}\`: ${size.toLocaleString("en-US")} bytes`;
  });
  return `Automated post-release follow-up for engine [\`${tag}\`](https://github.com/${REPO}/releases/tag/${tag}).

## Provenance

- Published engine tag: \`${tag}\`
- CLI/server transition: next development baseline \`${nextCliVersion}\`
${lines.join("\n")}

## Validation

- \`bun run check:versions\`
- \`bun run check:engine-targets\`
`;
}

export function buildPostEngineReleaseFollowup(input: FollowupInput): Followup {
  const version = input.tag.startsWith("v") ? input.tag.slice(1) : "";
  if (!isStableVersion(version)) throw new Error(`published tag ${input.tag} is not a stable engine version`);
  if (input.release.isDraft) throw new Error(`release ${input.tag} is still a draft`);
  if (input.release.isPrerelease) throw new Error(`release ${input.tag} is a prerelease`);
  if (input.manifest.tag !== input.tag || input.manifest.engineVersion !== version) {
    throw new Error(`release manifest does not identify published tag ${input.tag}`);
  }

  const releaseAssets = assetMap(input.release.assets);
  requireSignedAssets(input.manifest, releaseAssets);
  let targetSource = input.targetSource;
  for (const { target } of engineTargetEntries()) {
    const asset = releaseAssets.get(target.assetName);
    if (!asset) throw new Error(`release is missing engine asset ${target.assetName}`);
    if (!input.manifest.assets.some((entry) => entry.name === target.assetName)) {
      throw new Error(`release manifest is missing engine asset ${target.assetName}`);
    }
    targetSource = replaceTargetSize(targetSource, target.assetName, asset.size);
  }

  const pkg = parsePackage(input.packageSource);
  if (pkg.keshaEngine.version !== version) {
    throw new Error(
      `package.json#keshaEngine.version (${pkg.keshaEngine.version}) does not match published tag ${input.tag}`,
    );
  }
  const cli = parseSemver(pkg.version, "package.json#version");
  const engine = parseSemver(version, "published engine tag");
  if (cmp(cli, engine) < 0 || cli.prerelease.length > 0 || cli.build.length > 0) {
    throw new Error(`package.json#version (${pkg.version}) is not an unambiguous stable CLI baseline`);
  }
  if (!input.cliReleasePublished) {
    throw new Error(
      `CLI marker release v${pkg.version}-cli is not published; publish it before leading the next CLI baseline`,
    );
  }
  const nextCliVersion = `${cli.major}.${cli.minor + 1}.0`;
  const packageSource = `${JSON.stringify({ ...JSON.parse(input.packageSource), version: nextCliVersion }, null, 2)}\n`;
  const serverSource = replaceServerVersions(input.serverSource, pkg.version, nextCliVersion);

  return {
    nextCliVersion,
    targetSource,
    packageSource,
    serverSource,
    prBody: formatProvenance(input.tag, nextCliVersion, releaseAssets),
  };
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`usage: bun .github/scripts/post-engine-release.ts --tag vX.Y.Z`);
  return value;
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  return response.json();
}

async function releaseIsPublished(token: string, tag: string): Promise<boolean> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}) for CLI marker ${tag}`);
  const release = asRecord(await response.json(), "CLI marker release");
  return (
    !booleanAt(release.draft, "CLI marker release draft") &&
    !booleanAt(release.prerelease, "CLI marker release prerelease") &&
    typeof release.published_at === "string"
  );
}

async function main(): Promise<void> {
  const tag = option("--tag");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required to read the published release");
  const raw = asRecord(await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, token), "release");
  if (raw.published_at === null || typeof raw.published_at !== "string") {
    throw new Error(`release ${tag} is not published`);
  }
  if (!Array.isArray(raw.assets)) throw new Error("release assets must be an array");
  const assets = raw.assets.map((entry) => {
    const asset = asRecord(entry, "release asset");
    return {
      name: stringAt(asset.name, "release asset name"),
      size: asset.size as number,
      browser_download_url: stringAt(asset.browser_download_url, "release asset download URL"),
    };
  });
  const manifestAsset = assets.find((asset) => asset.name === "kesha-release-manifest.json");
  if (!manifestAsset?.browser_download_url) throw new Error(`release ${tag} has no kesha-release-manifest.json asset`);
  const manifest = parseManifest(await fetchJson(manifestAsset.browser_download_url, token));
  const targetSource = readFileSync("src/engine-targets.ts", "utf8");
  const packageSource = readFileSync("package.json", "utf8");
  const serverSource = readFileSync("server.json", "utf8");
  const cliReleasePublished = await releaseIsPublished(token, `v${parsePackage(packageSource).version}-cli`);
  const result = buildPostEngineReleaseFollowup({
    tag,
    cliReleasePublished,
    release: {
      isDraft: booleanAt(raw.draft, "release draft"),
      isPrerelease: booleanAt(raw.prerelease, "release prerelease"),
      assets,
    },
    manifest,
    targetSource,
    packageSource,
    serverSource,
  });
  writeFileSync("src/engine-targets.ts", result.targetSource);
  writeFileSync("package.json", result.packageSource);
  writeFileSync("server.json", result.serverSource);
  writeFileSync("post-release-pr.md", result.prBody);
  console.log(`prepared follow-up for ${tag}: CLI/server → ${result.nextCliVersion}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
