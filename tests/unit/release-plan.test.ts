import { describe, expect, test } from "bun:test";
import { parseRepoYaml } from "../helpers/repo";
import { classifyRelease, type ClassifyInput } from "../../.github/scripts/release-classify";
import { deriveReleaseAlpha, planRelease } from "../../.github/scripts/release-plan";

const TAGS = ["v1.26.0", "v1.31.0-cli", "v1.32.0-alpha.1-cli", "v1.32.0-alpha.2", "v1.25.0-beta.1", "audio-244"];
const RELEASES = [
  { tagName: "v1.31.0-cli", isDraft: false, isPrerelease: false },
  { tagName: "v1.26.0", isDraft: false, isPrerelease: false },
  { tagName: "v1.32.0-alpha.2", isDraft: false, isPrerelease: true },
];
const classify = (over: Partial<ClassifyInput>) =>
  classifyRelease({ eventName: "push", refType: "tag", refName: "v1.32.0", pkg: { version: "1.32.0" }, ...over });

describe("deriveReleaseAlpha", () => {
  test("counts past alphas of both the unified and the legacy -cli shape, so no npm version is reused", () => {
    expect(deriveReleaseAlpha("1.32.0", TAGS)).toEqual({ version: "1.32.0-alpha.3", tag: "v1.32.0-alpha.3", previous: "v1.32.0-alpha.2" });
  });

  test("a legacy -cli alpha higher than every unified one still advances the sequence", () => {
    expect(deriveReleaseAlpha("1.32.0", [...TAGS, "v1.32.0-alpha.4-cli"]).version).toBe("1.32.0-alpha.5");
  });

  test("a base that does not lead a published stable of either shape is refused, naming the fix", () => {
    expect(() => deriveReleaseAlpha("1.31.0", TAGS)).toThrow(/1\.31\.0.*bump package\.json#version/);
  });

  test("an empty tag list is refused rather than restarting the sequence", () => {
    expect(() => deriveReleaseAlpha("1.32.0", [])).toThrow(/no tags/);
  });

  test("a prerelease base is refused", () => {
    expect(() => deriveReleaseAlpha("1.32.0-beta.1", TAGS)).toThrow(/stable/);
  });
});

describe("planRelease", () => {
  test("a stable tag publishes its own version against the Engine of that version", () => {
    expect(planRelease({ classification: classify({}), pkgVersion: "1.32.0", tags: TAGS, releases: [] })).toEqual({
      version: "1.32.0",
      tag: "v1.32.0",
      engineVersion: "1.32.0",
      publish: true,
      previous: "",
    });
  });

  test("a labelled per-merge alpha derives its version and resolves the highest stable Engine release", () => {
    const plan = planRelease({
      classification: classify({ refType: "branch", refName: "main" }),
      pkgVersion: "1.32.0",
      tags: TAGS,
      releases: RELEASES,
      publishable: true,
    });
    expect(plan).toEqual({ version: "1.32.0-alpha.3", tag: "v1.32.0-alpha.3", engineVersion: "1.26.0", publish: true, previous: "v1.32.0-alpha.2" });
  });

  test("an unlabelled or unpacked merge plans nothing and derives nothing", () => {
    const plan = planRelease({ classification: classify({ refType: "branch", refName: "main" }), pkgVersion: "1.32.0", tags: [], releases: [], publishable: false });
    expect(plan).toEqual({ version: "", tag: "", engineVersion: "", publish: false, previous: "" });
  });

  test("a dispatched alpha resolves the Engine it builds, or the prerelease it names", () => {
    const dispatched = (enginePrerelease?: string) =>
      classify({ eventName: "workflow_dispatch", refType: "branch", refName: "main", dispatch: { channel: "alpha", enginePrerelease } });
    expect(planRelease({ classification: dispatched(), pkgVersion: "1.32.0", tags: TAGS, releases: [] }).engineVersion).toBe("1.32.0-alpha.3");
    expect(
      planRelease({ classification: dispatched("v1.32.0-beta.1"), pkgVersion: "1.32.0", tags: TAGS, releases: [], enginePrerelease: "v1.32.0-beta.1" })
        .engineVersion,
    ).toBe("1.32.0-beta.1");
  });

  test("a rehearsal plans the classified version and publishes nothing", () => {
    const plan = planRelease({ classification: classify({ eventName: "pull_request", refType: "branch" }), pkgVersion: "1.32.0", tags: [], releases: [] });
    expect(plan).toMatchObject({ version: "1.32.0", engineVersion: "1.32.0", publish: false });
  });
});

describe("the alpha tag step", () => {
  const step = parseRepoYaml(".github/workflows/release.yml").jobs["reserve-tag"].steps.find(
    (s: { run?: string }) => s.run === ".github/scripts/alpha-tag.sh",
  );

  // Behaviour lives in tests/integration/alpha-tag.test.ts, which runs the script for real.
  test("release.yml passes the planned previous tag through env", () => {
    expect(step.env.PREVIOUS).toBe("${{ needs.plan.outputs.previous }}");
  });
});
