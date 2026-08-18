import { describe, expect, test } from "bun:test";
import { buildPostEngineReleaseFollowup } from "../../.github/scripts/post-engine-release";
import { decideFollowup, ownsTag, refuseConcurrentFollowup } from "../../.github/scripts/post-release-guard";
import { parseRepoYaml } from "../helpers/repo";

const targetSource = `const ENGINE_TARGETS: Record<string, EngineTarget> = {
  "darwin-arm64": {
    assetName: "kesha-engine-darwin-arm64",
    backend: "coreml",
    sizeBytes: 1,
  },
  "linux-x64": {
    assetName: "kesha-engine-linux-x64",
    backend: "onnx",
    sizeBytes: 2,
  },
  "win32-x64": {
    assetName: "kesha-engine-windows-x64.exe",
    backend: "onnx",
    sizeBytes: 3,
  },
};
`;

const packageSource = JSON.stringify({
  name: "kesha",
  version: "1.29.0",
  keshaEngine: { version: "1.24.11" },
});

const serverSource = JSON.stringify({
  version: "1.29.0",
  packages: [{ version: "1.29.0" }],
});

function manifest() {
  return {
    tag: "v1.24.11",
    engineVersion: "1.24.11",
    assets: [
      { name: "kesha-engine-darwin-arm64", signatureBundle: "kesha-engine-darwin-arm64.sigstore.json" },
      { name: "kesha-engine-linux-x64", signatureBundle: "kesha-engine-linux-x64.sigstore.json" },
      { name: "kesha-engine-windows-x64.exe", signatureBundle: "kesha-engine-windows-x64.exe.sigstore.json" },
      { name: "SHA256SUMS", signatureBundle: "SHA256SUMS.sigstore.json" },
      { name: "kesha-release-manifest.json", signatureBundle: "kesha-release-manifest.json.sigstore.json" },
    ],
  };
}

function assets() {
  return [
    { name: "kesha-engine-darwin-arm64", size: 64_000_001 },
    { name: "kesha-engine-darwin-arm64.sigstore.json", size: 100 },
    { name: "kesha-engine-linux-x64", size: 65_000_002 },
    { name: "kesha-engine-linux-x64.sigstore.json", size: 100 },
    { name: "kesha-engine-windows-x64.exe", size: 66_000_003 },
    { name: "kesha-engine-windows-x64.exe.sigstore.json", size: 100 },
    { name: "SHA256SUMS", size: 100 },
    { name: "SHA256SUMS.sigstore.json", size: 100 },
    { name: "kesha-release-manifest.json", size: 100 },
    { name: "kesha-release-manifest.json.sigstore.json", size: 100 },
  ];
}

describe("buildPostEngineReleaseFollowup", () => {
  test("records published engine sizes and leads the CLI and registry by one minor", () => {
    const result = buildPostEngineReleaseFollowup({
      tag: "v1.24.11",
      cliReleasePublished: true,
      release: { isDraft: false, isPrerelease: false, assets: assets() },
      manifest: manifest(),
      targetSource,
      packageSource,
      serverSource,
    });

    expect(result.nextCliVersion).toBe("1.30.0");
    expect(result.targetSource).toContain("sizeBytes: 64_000_001");
    expect(result.targetSource).toContain("sizeBytes: 65_000_002");
    expect(result.targetSource).toContain("sizeBytes: 66_000_003");
    expect(JSON.parse(result.packageSource)).toMatchObject({
      version: "1.30.0",
      keshaEngine: { version: "1.24.11" },
    });
    expect(JSON.parse(result.serverSource)).toMatchObject({
      version: "1.30.0",
      packages: [{ version: "1.30.0" }],
    });
  });

  test("refuses an incomplete release instead of guessing an asset size", () => {
    const publishedAssets = assets().filter((asset) => asset.name !== "kesha-engine-linux-x64.sigstore.json");

    expect(() =>
      buildPostEngineReleaseFollowup({
        tag: "v1.24.11",
        cliReleasePublished: true,
        release: { isDraft: false, isPrerelease: false, assets: publishedAssets },
        manifest: manifest(),
        targetSource,
        packageSource,
        serverSource,
      }),
    ).toThrow(/missing signed asset/i);
  });

  test("refuses a source pin that does not identify the published tag", () => {
    expect(() =>
      buildPostEngineReleaseFollowup({
        tag: "v1.24.11",
        cliReleasePublished: true,
        release: { isDraft: false, isPrerelease: false, assets: assets() },
        manifest: manifest(),
        targetSource,
        packageSource: packageSource.replace("1.24.11", "1.24.12"),
        serverSource,
      }),
    ).toThrow(/does not match published tag/i);
  });

  test("refuses a server registry that is already out of step with the CLI baseline", () => {
    expect(() =>
      buildPostEngineReleaseFollowup({
        tag: "v1.24.11",
        cliReleasePublished: true,
        release: { isDraft: false, isPrerelease: false, assets: assets() },
        manifest: manifest(),
        targetSource,
        packageSource,
        serverSource: serverSource.replaceAll("1.29.0", "1.28.0"),
      }),
    ).toThrow(/does not match package\.json#version/i);
  });

  test("waits until the current CLI marker release has published before leading its base", () => {
    expect(() =>
      buildPostEngineReleaseFollowup({
        tag: "v1.24.11",
        cliReleasePublished: false,
        release: { isDraft: false, isPrerelease: false, assets: assets() },
        manifest: manifest(),
        targetSource,
        packageSource,
        serverSource,
      }),
    ).toThrow(/CLI marker release.*not published/i);
  });
});

describe("post-engine-release workflow", () => {
  test("runs only after publication or an explicit maintainer replay and never updates main directly", () => {
    const workflow = parseRepoYaml(".github/workflows/post-engine-release.yml");
    const job = workflow.jobs.follow_up;

    expect(workflow.on.release.types).toEqual(["published"]);
    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(job.permissions).toMatchObject({ contents: "write", "pull-requests": "write" });
    expect(job.concurrency.group).toContain("post-engine-release");
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("--state all"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("post-engine-release.ts"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("git switch -c"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("gh pr create"))).toBe(true);
  });

  // Every validating step here pipes — `{ bun run check:versions; ... } | tee` and
  // `git ls-remote | cut`. GitHub's *unspecified* default shell is `bash -e {0}` with no pipefail,
  // so those took `tee`'s and `cut`'s exit status: a failed check was recorded as output and a
  // failed ls-remote read as "no follow-up branch exists". Only `shell: bash` turns pipefail on (#1083).
  test("validation steps fail when a command inside them fails, not when the last one does", () => {
    const workflow = parseRepoYaml(".github/workflows/post-engine-release.yml");
    expect(workflow.defaults.run.shell).toBe("bash");
  });

  test("only a stable engine tag is owned by the follow-up", () => {
    for (const tag of ["v1.24.11", "v1.29.0", "v10.0.100", "v0.0.0"]) expect(ownsTag(tag)).toBe(true);
    for (const tag of ["v1.29.0-cli", "v1.24.11-alpha.1", "v1.24.11-beta.1", "1.24.11", "v1.24", "v01.2.3", "v1.2.3 "]) {
      expect(ownsTag(tag)).toBe(false);
    }
  });

  test("a follow-up refuses while another one exists as a branch or an open pull request", () => {
    const branch = "automation/post-release-v1.24.12";
    expect(refuseConcurrentFollowup({ branch, openHeads: [], remoteHeads: [] })).toBeNull();
    expect(refuseConcurrentFollowup({ branch, openHeads: [branch], remoteHeads: [`refs/heads/${branch}`] })).toBeNull();
    // Unrelated work must not block a release follow-up.
    expect(refuseConcurrentFollowup({ branch, openHeads: ["fix/issue-1", "docs/issue-2"], remoteHeads: [] })).toBeNull();
    // A branch exists before its pull request does, so either list alone must refuse.
    const viaPr = refuseConcurrentFollowup({ branch, openHeads: ["automation/post-release-v1.24.11"], remoteHeads: [] });
    expect(viaPr).toContain("automation/post-release-v1.24.11");
    const viaBranch = refuseConcurrentFollowup({ branch, openHeads: [], remoteHeads: ["refs/heads/automation/post-release-v1.24.11"] });
    expect(viaBranch).toContain("automation/post-release-v1.24.11");
  });

  test("the decision itself skips a foreign tag and refuses a concurrent follow-up", () => {
    const base = { TAG_NAME: "v1.24.12", BRANCH: "automation/post-release-v1.24.12" };
    expect(decideFollowup(base)).toEqual({ skip: false });
    expect(decideFollowup({ ...base, TAG_NAME: "v1.29.0-cli" })).toEqual({ skip: true });
    expect(decideFollowup({ ...base, TAG_NAME: "v1.24.12-beta.1" })).toEqual({ skip: true });
    const busy = decideFollowup({ ...base, OPEN_HEADS: "automation/post-release-v1.24.11" });
    expect(busy).toMatchObject({ refuse: expect.stringContaining("automation/post-release-v1.24.11") });
    const pushed = decideFollowup({ ...base, REMOTE_HEADS: "abc123\trefs/heads/automation/post-release-v1.24.11" });
    expect(pushed).toMatchObject({ refuse: expect.stringContaining("automation/post-release-v1.24.11") });
    expect(decideFollowup({ BRANCH: base.BRANCH })).toMatchObject({ refuse: expect.stringContaining("TAG_NAME") });
  });

  test("the workflow delegates both guards instead of restating them", () => {
    const job = parseRepoYaml(".github/workflows/post-engine-release.yml").jobs.follow_up;
    // Per-tag serialization let two tags read main's baseline at once, so the group carries no tag.
    expect(job.concurrency.group).toBe("post-engine-release");
    expect(job.concurrency["cancel-in-progress"]).toBe(false);
    const guard = job.steps.find((step: { id?: string }) => step.id === "shape").run;
    expect(guard).toContain("post-release-guard.ts");
    const mutating = job.steps.filter((step: { id?: string; run?: string }) =>
      step.id !== "shape" && step.id !== "existing" && step.run !== undefined,
    );
    expect(mutating.length).toBeGreaterThan(0);
    // A skipped step has no output, and "" != 'true' would otherwise let these run anyway.
    for (const step of mutating) expect(step.if).toContain("steps.shape.outputs.skip != 'true'");
  });
});
