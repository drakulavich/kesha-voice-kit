import { describe, expect, test } from "bun:test";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";

const WORKFLOW = ".github/workflows/release-install-smoke.yml";
const SCRIPT = ".github/scripts/release-install-smoke.sh";

describe("release install smoke", () => {
  test("keeps the draft gate manual and makes the post-npm path reusable", () => {
    const workflow = parseRepoYaml(WORKFLOW);

    expect(workflow.on.workflow_dispatch.inputs.mode.default).toBe("draft-engine");
    expect(workflow.on.workflow_call.inputs.version.required).toBe(true);
    expect(workflow.on.workflow_call.inputs.mode.default).toBe("npm");
    expect(workflow.jobs["draft-engine"].permissions).toEqual({ contents: "write" });
    expect(workflow.jobs.npm.permissions).toEqual({ contents: "read" });
  });

  test("downloads the authenticated draft artifact into a disposable private cache", () => {
    const script = readRepoFile(SCRIPT);
    const synthesisSmoke = readRepoFile(".github/scripts/smoke-synthesis.ts");

    expect(script).toContain('gh release download "$TAG"');
    expect(script).toContain('[ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = "true" ]');
    expect(script).toContain('KESHA_ENGINE_BIN="$assets/$asset"');
    expect(script).toContain('KESHA_CACHE_DIR="$scratch/cache"');
    expect(script).toContain('bun "$repo_root/.github/scripts/assert-install-warmup.ts"');
    expect(script).toContain('bun "$repo_root/.github/scripts/smoke-synthesis.ts"');
    expect(script).toContain('trap cleanup EXIT');
    expect(synthesisSmoke).toContain('process.env.KESHA_COMMAND || "kesha"');
  });

  test("installs an exact npm package and requires provenance metadata", () => {
    const script = readRepoFile(SCRIPT);

    expect(script).toContain('npm view "$package@$VERSION" --json version,dist.integrity,dist.attestations');
    expect(script).toContain('https://slsa.dev/provenance/v1');
    expect(script).toContain('npm install --global "$package@$VERSION"');
    expect(script).toContain('NPM_CONFIG_PREFIX="$prefix"');
    expect(script).toContain('installed npm package version was $installed_version, expected $VERSION');
  });

  test("runs the npm smoke only after the release lane has observed the published version", () => {
    const cliRelease = parseRepoYaml(".github/workflows/release-cli.yml");
    const job = cliRelease.jobs["published-install-smoke"];

    expect(job.needs).toEqual(["plan", "publish-npm"]);
    expect(job.uses).toBe("./.github/workflows/release-install-smoke.yml");
    expect(job.with).toEqual({
      tag: "${{ needs.plan.outputs.tag }}",
      version: "${{ needs.plan.outputs.version }}",
    });
  });
});
