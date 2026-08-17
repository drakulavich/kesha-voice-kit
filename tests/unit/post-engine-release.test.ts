import { describe, expect, test } from "bun:test";
import { buildPostEngineReleaseFollowup } from "../../.github/scripts/post-engine-release";
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
        release: { isDraft: false, isPrerelease: false, assets: assets() },
        manifest: manifest(),
        targetSource,
        packageSource,
        serverSource: serverSource.replaceAll("1.29.0", "1.28.0"),
      }),
    ).toThrow(/does not match package\.json#version/i);
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
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("post-engine-release.ts"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("git switch -c"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("gh pr create"))).toBe(true);
  });
});
