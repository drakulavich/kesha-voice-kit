import { describe, expect, test } from "bun:test";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const SCRIPT = ".github/scripts/release-install-smoke.sh";

describe("release install smoke", () => {
  test("stages the built artifact into a disposable private cache", () => {
    const script = readRepoFile(SCRIPT);
    const synthesisSmoke = readRepoFile(".github/scripts/smoke-synthesis.ts");

    expect(script).toContain('KESHA_ENGINE_BIN="$assets/$asset"');
    expect(script).toContain('KESHA_CACHE_DIR="$scratch/cache"');
    expect(script).toContain('bun "$repo_root/.github/scripts/assert-install-warmup.ts"');
    expect(script).toContain('bun "$repo_root/.github/scripts/smoke-synthesis.ts"');
    expect(script).toContain('trap cleanup EXIT');
    expect(synthesisSmoke).toContain('process.env.KESHA_COMMAND || "kesha"');
  });

  test("installs an exact npm package and requires provenance metadata", () => {
    const script = readRepoFile(SCRIPT);

    expect(script).toContain('bun "$repo_root/.github/scripts/npm-release-metadata.ts" "$package" "$VERSION"');
    // The gate replaced a fail() that annotated the job; a plain FAIL line would only reach the log.
    expect(readRepoFile(".github/scripts/npm-release-metadata.ts")).toContain("`::error::FAIL: ${");
    expect(script).toContain('npm install --global "$package@$VERSION"');
    expect(script).toContain('NPM_CONFIG_PREFIX="$prefix"');
    expect(script).toContain('installed npm package version was $installed_version, expected $VERSION');
  });

  test("runs the npm smoke only after release.yml has published the version", () => {
    const job = parseRepoYaml(".github/workflows/release.yml").jobs["npm-smoke"];

    expect(job.needs).toContain("npm-publish");
    expect(job.if).toContain("needs.npm-publish.result == 'success'");
    expect(job.env?.VERSION ?? job.steps.find((s: { run?: string }) => s.run?.includes(SCRIPT)).env.VERSION).toBe(
      "${{ needs.plan.outputs.version }}",
    );
  });

  test("artifact mode refuses an empty artifact directory by path, before touching any model", () => {
    const dir = tempDir("artifact-smoke-");
    const run = Bun.spawnSync(["bash", SCRIPT, "artifact"], {
      env: { ...process.env, ASSET_DIR: dir, ENGINE_VERSION: "2.0.0" },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(`${dir}/kesha-engine-linux-x64 is missing or empty`);
  });
});
