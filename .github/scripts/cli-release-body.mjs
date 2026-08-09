#!/usr/bin/env node
/**
 * The release body for a `vX.Y.Z-cli` marker tag.
 *
 * A CLI release is how a new engine reaches users, so the engine line is the one thing the body
 * must get right; it used to be a fixed string asserting "(unchanged)" even on the releases that
 * moved the pin (#788). Here it is computed against the previous release's pin, and the notes on
 * top of it come from the annotated tag message, read through the gate both lanes share.
 */
import { CLI_MARKER, STABLE_CLI_TAG_RE, cliPublishTarget } from "./release-tags.mjs";
import { isEntry } from "./script-entry.mjs";
import { git, readTagNotes } from "./tag-notes.mjs";
import { cmp, parseSemver } from "../../src/semver.mjs";

/**
 * The release whose engine pin this one is compared against: the highest stable marker below the
 * tag being published. Prerelease markers are excluded because this lane publishes no GitHub
 * release for them at all, so a delta measured against one names a release nobody ever saw.
 */
export function previousStableCliTag(tag, tags) {
  const current = parseSemver(cliPublishTarget(tag).version, "release tag");

  let best;
  for (const raw of tags) {
    const name = raw.trim();
    if (!STABLE_CLI_TAG_RE.test(name)) continue;
    const version = parseSemver(cliPublishTarget(name).version, "existing tag");
    if (cmp(version, current) >= 0) continue;
    if (!best || cmp(version, best.version) > 0) best = { tag: name, version };
  }
  return best?.tag;
}

/** An absent `previousEngineVersion` means "unknown", which is not the same as unchanged. */
export function composeCliReleaseBody({ version, engineVersion, previousEngineVersion, notes }) {
  const engine =
    previousEngineVersion === undefined
      ? `Engine: v${engineVersion}.`
      : previousEngineVersion === engineVersion
        ? `Engine: v${engineVersion} (unchanged).`
        : `Engine: v${previousEngineVersion} → v${engineVersion}.`;

  const generated = `v${version} (CLI-only). ${engine}`;
  const authored = notes?.trim();
  return authored ? `${authored}\n\n${generated}\n` : `${generated}\n`;
}

function enginePinAt(tag) {
  const manifest = git(["show", `${tag}:package.json`]);
  const pin = manifest === undefined ? undefined : JSON.parse(manifest).keshaEngine?.version;
  if (typeof pin !== "string") {
    console.error(`::notice::${tag} carries no readable engine pin, so the body will not compare against it.`);
    return undefined;
  }
  return pin;
}

function main() {
  const tag = process.env.TAG;
  const version = process.env.VERSION;
  const engineVersion = process.env.ENGINE_VERSION;
  if (!tag || !version || !engineVersion) {
    console.error("usage: TAG=… VERSION=… ENGINE_VERSION=… node .github/scripts/cli-release-body.mjs");
    process.exit(2);
  }

  const tags = (git(["tag", "--list"]) ?? "").split("\n").filter(Boolean);
  if (tags.length === 0) {
    throw new Error(
      `no tags are visible, so the previous release's engine pin cannot be read and the body for ${tag} ` +
        `would claim this is the first CLI release ever. A shallow checkout looks identical to a repo that ` +
        `has never released — check out with fetch-depth: 0 and re-run.`,
    );
  }

  const previous = previousStableCliTag(tag, tags);
  if (!previous) {
    console.error(`::notice::no stable ${CLI_MARKER} tag below ${tag}; the body will not claim the pin held still.`);
  }

  process.stdout.write(
    composeCliReleaseBody({
      version,
      engineVersion,
      previousEngineVersion: previous ? enginePinAt(previous) : undefined,
      notes: readTagNotes(tag),
    }),
  );
}

if (isEntry(import.meta.url)) main();
