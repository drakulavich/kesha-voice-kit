import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { planCliRelease } from "../../.github/scripts/cli-release-plan.mjs";

// Windows CI checks the repo out with CRLF, which no assertion here is about.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const pkg = (version: string, engineVersion = "1.24.9") => ({
  version,
  keshaEngine: { version: engineVersion },
});

describe("planCliRelease", () => {
  test("a stable marker tag releases packages for the version it names", () => {
    expect(planCliRelease("v1.27.0-cli", pkg("1.27.0"))).toEqual({
      version: "1.27.0",
      packages: true,
      engineVersion: "1.24.9",
    });
  });

  // The .deb carries package.json#version and nothing downstream re-checks it (#727, #728).
  test("a tag naming a version the commit does not carry is refused", () => {
    expect(() => planCliRelease("v1.26.0-cli", pkg("1.27.0"))).toThrow(
      "tag v1.26.0-cli names CLI 1.26.0 but package.json at that tag carries 1.27.0",
    );
  });

  test.each(["v1.27.0-beta.1-cli", "v1.27.0-alpha.3-cli"])("%s ships no packages", (tag) => {
    const plan = planCliRelease(tag, pkg("1.27.0"));

    expect(plan.packages).toBe(false);
    expect(plan.engineVersion).toBeUndefined();
  });

  // A prerelease marker is skipped before the drift guard, so main being ahead is not an error.
  test("a prerelease marker is not held to package.json", () => {
    expect(planCliRelease("v1.27.0-beta.1-cli", pkg("9.9.9")).packages).toBe(false);
  });

  test.each(["v1.27.0", "v1.27.0-alpha.1", "1.27.0-cli", "v1.27-cli", "v1.27.0; id-cli", "v1.27.0-rc.1-cli"])(
    "%s is not a CLI marker tag",
    (tag) => {
      expect(() => planCliRelease(tag, pkg("1.27.0"))).toThrow("must be a CLI marker tag");
    },
  );

  test("a package.json with no engine pin cannot name one in the notes", () => {
    expect(() => planCliRelease("v1.27.0-cli", { version: "1.27.0" })).toThrow("no keshaEngine.version");
  });
});

describe("the CLI release lane", () => {
  // The lane exists to publish packages and npm together; a wider filter would run it on
  // engine tags, which publish neither (#729).
  test("release-cli.yml fires on CLI marker tags only", () => {
    const workflow = parse(read(".github/workflows/release-cli.yml"));

    expect(workflow.on.push.tags).toEqual(["v*-cli"]);
    expect(workflow.on.push.branches).toBeUndefined();
  });

  test("the packaging job is the one holding contents: write", () => {
    const jobs = parse(read(".github/workflows/release-cli.yml")).jobs;

    expect(jobs.packages.permissions).toEqual({ contents: "write" });
    expect(jobs["publish-npm"].permissions).toEqual({ contents: "read", actions: "write" });
  });

  // Assets go onto a draft and the release is un-drafted afterwards: releases here are
  // immutable, so an asset uploaded to a published one 422s.
  test("the packages are attached before the release goes public", () => {
    const script = read(".github/scripts/publish-cli-release.sh");
    const create = script.indexOf("gh release create");
    const undraft = script.indexOf("--draft=false");

    expect(script).toContain("--draft \\");
    expect(create).toBeGreaterThan(-1);
    expect(undraft).toBeGreaterThan(create);
  });

  // nfpm's input sits in the same directory as its output; uploading it would ship a
  // 50 MB compiled wrapper as a release asset.
  test("only the packages and their checksums are uploaded", () => {
    const script = read(".github/scripts/publish-cli-release.sh");

    expect(script).toContain('"$DIR"/*.deb "$DIR"/*.rpm "$DIR/SHA256SUMS"');
  });
});
