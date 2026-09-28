import { describe, expect, test } from "bun:test";
import { buildPostEngineReleaseFollowup } from "../../.github/scripts/post-engine-release";
import { decideExisting, decideFollowup, ownsTag, refuseConcurrentFollowup } from "../../.github/scripts/post-release-guard";
import { parseRepoYaml, readRepoFile, REPO_ROOT } from "../helpers/repo";

/** A step's own `run:` text plus the body of any `.github/scripts/*.sh` it hands off to. */
function runText(step: { run?: string }): string {
  const script = /\bbash (\.github\/scripts\/[\w.-]+\.sh)\b/.exec(step.run ?? "")?.[1];
  return `${step.run ?? ""}\n${script ? readRepoFile(script) : ""}`;
}

const packageSource = JSON.stringify({ name: "kesha", version: "1.24.11" });

const serverSource = JSON.stringify({
  version: "1.24.11",
  packages: [{ version: "1.24.11" }],
});

const cargoSource = `[package]\nname = "kesha-engine"\nversion = "1.24.11"\n\n[dependencies]\nort = { version = "2.0.0" }\n`;

const lockSource = `[[package]]\nname = "itoa"\nversion = "1.24.11"\n\n[[package]]\nname = "kesha-engine"\nversion = "1.24.11"\ndependencies = [\n "itoa",\n]\n`;

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
  // Hashes and sizes are injected at publish now, so the lead PR touches no source table (#1263, openspec unified-release D1).
  test("leads package.json, server.json and the Engine crate by one minor", () => {
    const result = buildPostEngineReleaseFollowup({
      tag: "v1.24.11",
      release: { isDraft: false, isPrerelease: false, assets: assets() },
      manifest: manifest(),
      packageSource,
      serverSource,
      cargoSource,
      lockSource,
    });

    expect(result.nextVersion).toBe("1.25.0");
    expect(JSON.parse(result.packageSource)).toEqual({ name: "kesha", version: "1.25.0" });
    expect(JSON.parse(result.serverSource)).toMatchObject({
      version: "1.25.0",
      packages: [{ version: "1.25.0" }],
    });
    expect(result.cargoSource).toBe(cargoSource.replace('version = "1.24.11"', 'version = "1.25.0"'));
    // Only the Engine's own lock entry moves; a dependency that happens to share the version stays.
    expect(result.lockSource).toBe(lockSource.replace('"kesha-engine"\nversion = "1.24.11"', '"kesha-engine"\nversion = "1.25.0"'));
  });

  test("refuses an incomplete release", () => {
    const publishedAssets = assets().filter((asset) => asset.name !== "kesha-engine-linux-x64.sigstore.json");

    expect(() =>
      buildPostEngineReleaseFollowup({
        tag: "v1.24.11",
          release: { isDraft: false, isPrerelease: false, assets: publishedAssets },
        manifest: manifest(),
        packageSource,
        serverSource,
        cargoSource,
        lockSource,
      }),
    ).toThrow(/missing signed asset/i);
  });

  test("refuses a package.json whose version is not the published tag", () => {
    expect(() =>
      buildPostEngineReleaseFollowup({
        tag: "v1.24.11",
          release: { isDraft: false, isPrerelease: false, assets: assets() },
        manifest: manifest(),
        packageSource: packageSource.replace("1.24.11", "1.24.12"),
        serverSource,
        cargoSource,
        lockSource,
      }),
    ).toThrow(/does not match published tag/i);
  });

  test("refuses a server registry that is already out of step with the CLI baseline", () => {
    expect(() =>
      buildPostEngineReleaseFollowup({
        tag: "v1.24.11",
          release: { isDraft: false, isPrerelease: false, assets: assets() },
        manifest: manifest(),
        packageSource,
        serverSource: serverSource.replaceAll("1.24.11", "1.24.10"),
        cargoSource,
        lockSource,
      }),
    ).toThrow(/does not match package\.json#version/i);
  });
});

describe("the post-release job", () => {
  const RELEASE = ".github/workflows/release.yml";
  // A release created with GITHUB_TOKEN fires no `release: published`, so the follow-up is a job, not a listener.
  test("runs only after a published stable release and never updates main directly", () => {
    const job = parseRepoYaml(RELEASE).jobs["post-release"];

    expect(job.needs).toContain("github-release");
    expect(job.if).toContain("needs.github-release.result == 'success'");
    // The old follow-up refused until the CLI of the released version was out; a lead PR must not outrun npm.
    expect(job.needs).toContain("npm-smoke");
    expect(job.if).toContain("needs.npm-smoke.result == 'success'");
    expect(job.if).toContain("needs.classify.outputs.channel == 'stable'");
    expect(job.permissions).toMatchObject({ contents: "write", "pull-requests": "write" });
    expect(job.concurrency.group).toBe("post-release");
    expect(job.steps.some((step: { run?: string }) => runText(step).includes("--state all"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => runText(step).includes("post-engine-release.ts"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => runText(step).includes("git switch -c"))).toBe(true);
    expect(job.steps.some((step: { run?: string }) => runText(step).includes("gh pr create"))).toBe(true);
  });

  // Every validating step here pipes — `{ bun run check:versions; ... } | tee` and
  // `git ls-remote | cut`. GitHub's *unspecified* default shell is `bash -e {0}` with no pipefail,
  // so those took `tee`'s and `cut`'s exit status: a failed check was recorded as output and a
  // failed ls-remote read as "no follow-up branch exists". Only `shell: bash` turns pipefail on (#1083).
  // Unauthenticated, check:engine-targets reads a rate-limited release API as "skip" and passes.
  test("the validation step is authenticated", () => {
    const steps = parseRepoYaml(RELEASE).jobs["post-release"].steps as { run?: string; env?: Record<string, string> }[];
    const validate = steps.find((step) => step.run?.includes("record-post-release-validation.sh"));
    expect(validate?.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
  });

  test("validation steps fail when a command inside them fails, not when the last one does", () => {
    const workflow = parseRepoYaml(RELEASE);
    expect(workflow.defaults.run.shell).toBe("bash");

    const steps = workflow.jobs["post-release"].steps as { shell?: string; run?: string }[];
    expect(steps.filter((step) => step.run !== undefined).length).toBeGreaterThan(0);
    for (const step of steps) expect(step.shell ?? "bash").toBe("bash");
    // A step that hands off to a script leaves pipefail to that script, which bash runs without the step's flags.
    for (const step of steps.filter((step) => /\bbash \.github\/scripts\//.test(step.run ?? ""))) {
      expect(runText(step)).toContain("set -euo pipefail");
    }
  });

  test("only a stable tag is owned by the follow-up", () => {
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
    const job = parseRepoYaml(RELEASE).jobs["post-release"];
    // Per-tag serialization let two tags read main's baseline at once, so the group carries no tag.
    expect(job.concurrency.group).toBe("post-release");
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

describe("an existing pull request on the follow-up branch", () => {
  const tag = "v1.24.12";
  const branch = "automation/post-release-v1.24.12";
  const ours = {
    title: "chore(release): record v1.24.12 assets and lead main to v1.24.13",
    body: "Published engine tag: `v1.24.12`\n\nmore text",
  };

  test("none means the follow-up proceeds", () => {
    expect(decideExisting([], tag, branch)).toEqual({ skip: false });
  });

  test("one carrying this tag's title and body is left untouched", () => {
    expect(decideExisting([ours], tag, branch)).toEqual({ skip: true });
  });

  test("one that misses either half of the predicate is refused as unrelated", () => {
    const unrelated = { refuse: `An unrelated PR already uses ${branch}; refusing to touch it.` };
    expect(decideExisting([{ ...ours, title: "chore(release): record v1.24.1 assets and lead main to v1.24.2" }], tag, branch)).toEqual(unrelated);
    expect(decideExisting([{ ...ours, body: "Published engine tag: `v1.24.1`" }], tag, branch)).toEqual(unrelated);
    expect(decideExisting([{ ...ours, title: `fix: ${ours.title}` }], tag, branch)).toEqual(unrelated);
  });

  test("more than one is refused as ambiguous, even when one of them matches", () => {
    expect(decideExisting([ours, ours], tag, branch)).toEqual({
      refuse: `More than one open PR uses ${branch}; refusing an ambiguous follow-up.`,
    });
  });

  async function runGuard(prs: unknown) {
    const proc = Bun.spawn(["bun", `${REPO_ROOT}/.github/scripts/post-release-guard.ts`, "existing"], {
      env: { ...process.env, TAG_NAME: tag, BRANCH: branch },
      stdin: Buffer.from(JSON.stringify(prs)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  // stdout is appended to $GITHUB_OUTPUT, so it may carry nothing but the key=value line.
  test("the script mode prints only the output line on stdout and refuses with exit 1", async () => {
    expect(await runGuard([])).toMatchObject({ exitCode: 0, stdout: "skip=false\n" });
    const kept = await runGuard([ours]);
    expect(kept).toMatchObject({ exitCode: 0, stdout: "skip=true\n" });
    expect(kept.stderr).toContain("A matching follow-up PR for v1.24.12 is already open; leaving it untouched.");
    const refused = await runGuard([ours, ours]);
    expect(refused).toMatchObject({ exitCode: 1, stdout: "" });
    expect(refused.stderr).toContain("::error::More than one open PR uses");
  });

  test("the workflow step hands the listing to the guard instead of deciding in jq", () => {
    const script = readRepoFile(".github/scripts/refuse-existing-followup.sh");
    expect(script).toContain("post-release-guard.ts existing");
    expect(script).not.toContain("jq");
  });
});
