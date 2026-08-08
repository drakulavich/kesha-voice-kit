#!/usr/bin/env node
/**
 * What `release-cli.yml` should do with the `-cli` marker tag it was pushed.
 *
 * Linux packages carry `package.json#version` and nothing downstream re-checks it, so the
 * lane that attaches them is the only place the tag and the packaged version can be held
 * to each other — the assertion #727 removed and #728 replaced with this lane.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateLinuxPackageVersion } from "./linux-package-names.mjs";
import { CLI_MARKER, CLI_TAG_RE, cliPublishTarget } from "./release-tags.mjs";
import { isStableVersion } from "../../src/semver.mjs";

export function planCliRelease(tag, pkg) {
  if (!CLI_TAG_RE.test(tag)) {
    throw new Error(
      `release tag must be a CLI marker tag (vX.Y.Z${CLI_MARKER}, vX.Y.Z-beta.N${CLI_MARKER} or ` +
        `vX.Y.Z-alpha.N${CLI_MARKER}), got: ${tag}`,
    );
  }

  const { version } = cliPublishTarget(tag);
  if (!isStableVersion(version)) return { version, packages: false };

  if (pkg?.version !== version) {
    throw new Error(
      `tag ${tag} names CLI ${version} but package.json at that tag carries ${pkg?.version} — ` +
        `the Linux packages would be named for a version this commit is not. Bump the patch, ` +
        `re-tag, and push again; tag names are one-use.`,
    );
  }
  const engineVersion = pkg.keshaEngine?.version;
  if (typeof engineVersion !== "string") {
    throw new Error(`package.json at ${tag} has no keshaEngine.version to name in the release notes`);
  }

  validateLinuxPackageVersion(version);
  return { version, packages: true, engineVersion };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: node .github/scripts/cli-release-plan.mjs <tag>");
    process.exit(2);
  }

  // The tag is echoed back rather than written by the workflow: it reaches GITHUB_OUTPUT only
  // once the grammar has accepted it, so a dispatch input carrying a newline cannot append keys.
  const plan = planCliRelease(tag, JSON.parse(readFileSync("package.json", "utf8")));
  if (!plan.packages) {
    console.error(
      `::notice::${tag} is a prerelease marker — beta and alpha CLI markers ship no Linux ` +
        `packages and no GitHub release from this lane. Publish it the legacy way: ` +
        `gh release create ${tag} --title "${plan.version} (CLI-only)" --notes "…".`,
    );
  }
  process.stdout.write(
    `tag=${tag}\nversion=${plan.version}\npackages=${plan.packages}\nengine_version=${plan.engineVersion ?? ""}\n`,
  );
}
