import { describe, expect, test } from "bun:test";
import { planCliRelease } from "../../.github/scripts/cli-release-plan.mjs";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";

const RELEASE_CLI = ".github/workflows/release-cli.yml";

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
    const workflow = parseRepoYaml(RELEASE_CLI);

    expect(workflow.on.push.tags).toEqual(["v*-cli"]);
    expect(workflow.on.push.branches).toBeUndefined();
  });

  // plan holds write only so `gh release view` can see drafts; a read-only token cannot.
  test("only the jobs that touch releases hold contents: write", () => {
    const jobs = parseRepoYaml(RELEASE_CLI).jobs;

    expect(jobs.plan.permissions).toEqual({ contents: "write" });
    expect(jobs.packages.permissions).toEqual({ contents: "write" });
    expect(jobs["publish-npm"].permissions).toEqual({ contents: "read", actions: "write" });
  });

  // Writing the raw dispatch input to GITHUB_OUTPUT before validating it would let a tag
  // carrying a newline append its own output keys, so the validator echoes the tag instead.
  test("the tag reaches GITHUB_OUTPUT only from the validator", () => {
    const plan = parseRepoYaml(RELEASE_CLI).jobs.plan;
    const step = plan.steps.find((s: { id?: string }) => s.id === "plan");

    expect(plan.outputs.tag).toBe("${{ steps.plan.outputs.tag }}");
    expect(step.run).toContain("cli-release-plan.mjs");
    expect(step.run).not.toContain("${{");
    expect(plan.steps.some((s: { run?: string }) => /tag=.*>>.*GITHUB_OUTPUT/.test(s.run ?? ""))).toBe(false);
  });

  // Assets go onto a draft and the release is un-drafted afterwards: releases here are
  // immutable, so an asset uploaded to a published one 422s.
  test("the packages are attached before the release goes public", () => {
    const script = readRepoFile(".github/scripts/publish-cli-release.sh");
    const create = script.indexOf("gh release create");
    const undraft = script.indexOf("--draft=false");

    expect(script).toContain("--draft \\");
    expect(create).toBeGreaterThan(-1);
    expect(undraft).toBeGreaterThan(create);
  });

  // nfpm's input sits in the same directory as its output; uploading it would ship a
  // 50 MB compiled wrapper as a release asset.
  test("only the packages and their checksums are uploaded", () => {
    const script = readRepoFile(".github/scripts/publish-cli-release.sh");

    expect(script).toContain('"$DIR"/*.deb "$DIR"/*.rpm "$DIR/SHA256SUMS"');
  });

  // A CLI release is how a new engine reaches users, and the body used to assert the
  // opposite from a fixed string (#788).
  test("the body is composed, not spelled out in the publish script", () => {
    const script = readRepoFile(".github/scripts/publish-cli-release.sh");

    expect(script).toContain("cli-release-body.mjs");
    expect(script).toContain("--notes-file");
    expect(script).not.toContain("unchanged");
  });

  // Without the tags and the history behind them, the previous pin is invisible and every
  // release would read as the first one.
  test("the publishing job checks out enough history to see the previous release", () => {
    const checkout = parseRepoYaml(RELEASE_CLI).jobs.packages.steps.find((s: { uses?: string }) =>
      s.uses?.startsWith("actions/checkout"),
    );

    expect(checkout.with["fetch-depth"]).toBe(0);
    expect(checkout.with["fetch-tags"]).toBe(true);
  });
});
