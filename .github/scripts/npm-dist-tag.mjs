#!/usr/bin/env node
/**
 * Resolve the npm dist-tag a version publishes to.
 *
 * Derived from the SemVer prerelease identifier rather than from a hardcoded list, so a new
 * channel needs no edit here: `1.27.0-alpha.1` → `alpha`, `-rc.1` → `rc`, stable → `latest`.
 * Publishing a prerelease to `latest` would hand it to everyone who never named a channel,
 * so a version that decodes to `latest` is rejected instead (#685).
 *
 * Run via `node .github/scripts/npm-dist-tag.mjs [version]`; prints the tag on stdout.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHANNEL_RE = /^[a-z][a-z0-9-]*$/;

export function npmDistTag(version) {
  if (typeof version !== "string" || version === "") {
    throw new Error("npm dist-tag needs a version string");
  }
  if (!version.includes("-")) return "latest";

  const channel = version.slice(version.indexOf("-") + 1).split(".")[0];
  if (!CHANNEL_RE.test(channel)) {
    throw new Error(
      `cannot resolve an npm dist-tag from prerelease version ${version}: ` +
        `'${channel}' is not a usable channel name (expected something like alpha, beta, rc)`,
    );
  }
  if (channel === "latest") {
    throw new Error(
      `refusing to publish prerelease ${version} to the 'latest' dist-tag — ` +
        "it would reach everyone who did not ask for a prerelease",
    );
  }
  return channel;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
  process.stdout.write(`${npmDistTag(version)}\n`);
}
