import { afterEach, describe, expect, test } from "bun:test";
import { cleanupGitRepos, commit, git, gitRepoWithRemote } from "../helpers/git-repo";
import { parseRepoYaml } from "../helpers/repo";

afterEach(cleanupGitRepos);

type Step = { run?: unknown };

// Executes the real step's shell, not a hand-copied stand-in — a copy can drift from what ships
// and still read as coverage, which is what shipped the tag-object-vs-commit bug (#1115 review).
function guardScript(): string {
  const document = parseRepoYaml(".github/workflows/build-engine.yml") as {
    jobs?: { release?: { steps?: Step[] } };
  };
  const steps = document.jobs?.release?.steps ?? [];
  const guard = steps.find(
    (step) => typeof step.run === "string" && step.run.includes("refs/tags") && step.run.includes("GITHUB_SHA"),
  );
  if (!guard || typeof guard.run !== "string") throw new Error("release job has no tag-currency guard step");
  return guard.run;
}

async function runGuard(work: string, tagName: string, sha: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bash", "-c", guardScript()], {
    cwd: work,
    env: { ...process.env, TAG_NAME: tagName, GITHUB_SHA: sha },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("build-engine.yml release job: tag-currency guard", () => {
  test("passes an annotated tag that has not moved", async () => {
    const work = await gitRepoWithRemote();
    const sha = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "-a", "v1.0.0", "-m", "notes");
    await git(work, "push", "-q", "origin", "refs/tags/v1.0.0");

    expect((await runGuard(work, "v1.0.0", sha)).code).toBe(0);
  });

  // The bug this whole guard exists to catch: a re-point between trigger and the release job.
  test("fails an annotated tag re-pointed after the recorded SHA", async () => {
    const work = await gitRepoWithRemote();
    const original = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "-a", "v1.0.0", "-m", "notes");
    await git(work, "push", "-q", "origin", "refs/tags/v1.0.0");

    await commit(work, "later work");
    await git(work, "tag", "-f", "-a", "v1.0.0", "-m", "notes2");
    await git(work, "push", "-qf", "origin", "refs/tags/v1.0.0");

    const { code, stdout } = await runGuard(work, "v1.0.0", original);
    expect(code).toBe(1);
    expect(stdout).toContain("re-pointed mid-build");
  });

  // `git rev-parse refs/tags/<annotated>` alone returns the tag object, never GITHUB_SHA — this
  // case is what shipped a guard that reds every annotated release (#1115 review, P1).
  test("does not fail an annotated tag just because it carries an annotation", async () => {
    const work = await gitRepoWithRemote();
    const sha = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "-a", "v1.0.0", "-m", "notes");
    await git(work, "push", "-q", "origin", "refs/tags/v1.0.0");

    const { code, stdout } = await runGuard(work, "v1.0.0", sha);
    expect({ code, stdout }).toEqual({ code: 0, stdout: "" });
  });

  test("passes a lightweight tag that has not moved", async () => {
    const work = await gitRepoWithRemote();
    const sha = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "v2.0.0");
    await git(work, "push", "-q", "origin", "refs/tags/v2.0.0");

    expect((await runGuard(work, "v2.0.0", sha)).code).toBe(0);
  });

  test("fails a lightweight tag re-pointed after the recorded SHA", async () => {
    const work = await gitRepoWithRemote();
    const original = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "v2.0.0");
    await git(work, "push", "-q", "origin", "refs/tags/v2.0.0");

    await commit(work, "later work");
    await git(work, "tag", "-f", "v2.0.0");
    await git(work, "push", "-qf", "origin", "refs/tags/v2.0.0");

    expect((await runGuard(work, "v2.0.0", original)).code).toBe(1);
  });
});
