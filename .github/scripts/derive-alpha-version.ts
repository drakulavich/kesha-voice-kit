#!/usr/bin/env bun
/**
 * Derive the next alpha version and tag from the tags that already exist.
 *
 * No commit records an alpha version — the sequence lives in the tags, which is why every
 * published alpha must leave one behind (#685). Run with `cli` or `engine`; prints
 * `version=`/`tag=` lines suitable for `$GITHUB_OUTPUT`.
 */
import { readFileSync } from "node:fs";
import { CLI_MARKER, publishedVersionRe, stableVersionRe } from "./release-tags.mjs";
import { cmp, parseSemver } from "../../src/semver.mjs";

export type Channel = "cli" | "engine";

/** CLI alphas carry the `-cli` marker so the engine build's `!v*-cli` filter skips them (#685). */
const MARKER: Record<Channel, string> = { cli: CLI_MARKER, engine: "" };

export function alphaTag(channel: Channel, base: string, sequence: number): string {
  return `v${base}-alpha.${sequence}${MARKER[channel]}`;
}

export function nextSequence(channel: Channel, base: string, tags: string[]): number {
  if (tags.length === 0) {
    throw new Error(
      "no tags visible — refusing to derive a sequence that would restart at 1. " +
        "Fetch full history and tags before deriving (a shallow checkout looks identical to a fresh repo).",
    );
  }
  const pattern = new RegExp(
    `^v${base.replace(/[.\\+*?^$()[\]{}|]/g, "\\$&")}-alpha\\.(\\d+)${MARKER[channel]}$`,
  );
  let highest = 0;
  for (const tag of tags) {
    const match = pattern.exec(tag.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/**
 * The tag the next alpha's notes are counted from: the highest thing already published on this
 * channel. Preferring alphas would anchor the range at an ancient one once anything shipped
 * after it, making the notes span months.
 */
export function previousTag(channel: Channel, tags: string[]): string | undefined {
  const shape = publishedVersionRe(MARKER[channel]);

  let best: { tag: string; version: ReturnType<typeof parseSemver> } | undefined;
  for (const raw of tags) {
    const match = shape.exec(raw.trim());
    if (!match) continue;
    const version = parseSemver(match[1], "existing tag");
    if (!best || cmp(version, best.version) > 0) best = { tag: raw.trim(), version };
  }
  return best?.tag;
}

/**
 * A prerelease sorts below its own stable version, so an alpha of an already-released base is
 * older than what the channel already serves — npm showed `@alpha` 1.27.0-alpha.2 behind
 * `@latest` 1.27.0 (#802). The refusal reads the same tags the sequence is counted from.
 */
export function assertBaseLeadsPublished(channel: Channel, base: string, tags: string[]): void {
  const shape = stableVersionRe(MARKER[channel]);

  let highest: { raw: string; version: ReturnType<typeof parseSemver> } | undefined;
  for (const tag of tags) {
    const match = shape.exec(tag.trim());
    const captured = match?.[1];
    if (!captured) continue;
    const version = parseSemver(captured, "published stable");
    if (!highest || cmp(version, highest.version) > 0) highest = { raw: captured, version };
  }
  if (!highest) return;
  if (cmp(parseSemver(base, "alpha base"), highest.version) > 0) return;

  const remedy =
    channel === "cli"
      ? "bump package.json#version on main to the next unreleased version — the release-cli " +
        "skill's 'Re-lead the base version on main' step"
      : "name an engine base above it";
  throw new Error(
    `${channel} alpha base ${base} does not lead the highest published stable ${highest.raw}: ` +
      `${base}-alpha.N sorts below ${highest.raw}, so the alpha channel would serve a version older ` +
      `than the released one. Fix: ${remedy}.`,
  );
}

/**
 * `check-versions.ts` requires the CLI version to be >= the engine version, and a prerelease
 * sorts below its own stable version — so a CLI base equal to the engine version would make
 * every alpha of it fail that gate. Refuse here rather than at publish time.
 */
export function assertPassesVersionGate(version: string, engineVersion: string): void {
  if (cmp(parseSemver(version, "derived version"), parseSemver(engineVersion, "engine version")) < 0) {
    throw new Error(
      `derived version ${version} is below package.json#keshaEngine.version (${engineVersion}) ` +
        "and would fail `bun run check:versions`. Bump the base on main so it leads the engine version.",
    );
  }
}

/**
 * The CLI base comes from `package.json#version`, which main carries as the *next* unreleased
 * version. `keshaEngine.version` is the opposite — the *released* engine the CLI downloads — so
 * an engine alpha must name its target explicitly, or it would derive an alpha of an already
 * released version, which sorts below it and reads as a downgrade.
 */
export function deriveAlpha(
  channel: Channel,
  pkg: { version: string; keshaEngine?: { version?: string } },
  tags: string[],
  engineBase?: string,
): { version: string; tag: string; sequence: number } {
  const engineVersion = pkg.keshaEngine?.version ?? pkg.version;
  let base: string;

  if (channel === "cli") {
    base = pkg.version;
  } else {
    if (!engineBase) {
      throw new Error(
        "an engine alpha needs its target version — package.json#keshaEngine.version " +
          `(${engineVersion}) names the released engine, and an alpha of it would sort below it`,
      );
    }
    base = engineBase;
    if (cmp(parseSemver(base, "engine base"), parseSemver(engineVersion, "engine version")) <= 0) {
      throw new Error(
        `engine alpha base ${base} must be above the released engine version ${engineVersion}`,
      );
    }
  }

  if (base.includes("-")) {
    throw new Error(`alpha base must be a stable version, got ${base} — alphas derive from it`);
  }

  assertBaseLeadsPublished(channel, base, tags);

  const sequence = nextSequence(channel, base, tags);
  const version = `${base}-alpha.${sequence}`;
  if (channel === "cli") assertPassesVersionGate(version, engineVersion);

  return { version, tag: alphaTag(channel, base, sequence), sequence };
}

if (import.meta.main) {
  const channel = process.argv[2] as Channel;
  if (channel !== "cli" && channel !== "engine") {
    console.error("usage: bun .github/scripts/derive-alpha-version.ts <cli|engine> [engine-base-version]");
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const tags = Bun.spawnSync(["git", "tag", "--list"]).stdout.toString().split("\n").filter(Boolean);
  const derived = deriveAlpha(channel, pkg, tags, process.argv[3]);
  process.stdout.write(
    `version=${derived.version}\ntag=${derived.tag}\nprevious=${previousTag(channel, tags) ?? ""}\n`,
  );
}
