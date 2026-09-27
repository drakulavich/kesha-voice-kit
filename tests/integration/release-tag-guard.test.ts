import { afterEach, describe, expect, test } from "bun:test";
import { cleanupGitRepos, cloneFrom, commit, git, gitRepoWithRemote } from "../helpers/git-repo";
import { parseRepoYaml } from "../helpers/repo";

afterEach(cleanupGitRepos);

type Step = { run?: unknown };

// Executes the real step's shell, not a hand-copied stand-in — a copy can drift from what ships
// and still read as coverage, which is what shipped the tag-object-vs-commit bug (#1115 review).
function guardScript(): string {
  const document = parseRepoYaml(".github/workflows/release.yml") as {
    jobs?: { "github-release"?: { steps?: Step[] } };
  };
  const steps = document.jobs?.["github-release"]?.steps ?? [];
  const guard = steps.find(
    (step) => typeof step.run === "string" && step.run.includes("refs/tags") && step.run.includes("GITHUB_SHA"),
  );
  if (!guard || typeof guard.run !== "string") throw new Error("github-release has no tag-currency guard step");
  return guard.run;
}

// Mirrors GHA's real `bash --noprofile --norc -eo pipefail {0}` — plain `bash -c` masks a failed `git ls-remote` as an empty `current` instead of aborting (#1115 review round 2).
async function runGuard(work: string, tagName: string, sha: string, refType = "tag"): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", guardScript()], {
    cwd: work,
    env: { ...process.env, TAG_NAME: tagName, GITHUB_SHA: sha, REF_TYPE: refType },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("release.yml github-release: tag-currency guard", () => {
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
    expect(stdout).toContain("Refusing to publish");
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

  // Re-points via a second clone so `work`'s local ref stays stale — a guard reading it instead of querying origin wrongly passes.
  test("fails an annotated tag re-pointed on the remote only, with the local checkout untouched", async () => {
    const work = await gitRepoWithRemote();
    const original = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "-a", "v1.0.0", "-m", "notes");
    await git(work, "push", "-q", "origin", "refs/tags/v1.0.0");

    const other = await cloneFrom(work);
    await git(other, "checkout", "-q", "v1.0.0");
    await commit(other, "later work");
    await git(other, "tag", "-f", "-a", "v1.0.0", "-m", "notes2");
    await git(other, "push", "-qf", "origin", "refs/tags/v1.0.0");

    expect(await git(work, "rev-parse", "refs/tags/v1.0.0^{commit}")).toBe(original);
    expect((await runGuard(work, "v1.0.0", original)).code).toBe(1);
  });

  test("fails a lightweight tag re-pointed on the remote only, with the local checkout untouched", async () => {
    const work = await gitRepoWithRemote();
    const original = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "v2.0.0");
    await git(work, "push", "-q", "origin", "refs/tags/v2.0.0");

    const other = await cloneFrom(work);
    await git(other, "checkout", "-q", "v2.0.0");
    await commit(other, "later work");
    await git(other, "tag", "-f", "v2.0.0");
    await git(other, "push", "-qf", "origin", "refs/tags/v2.0.0");

    expect(await git(work, "rev-parse", "refs/tags/v2.0.0")).toBe(original);
    expect((await runGuard(work, "v2.0.0", original)).code).toBe(1);
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

  test("a tag push whose tag is gone refuses rather than letting the publish create it elsewhere", async () => {
    const work = await gitRepoWithRemote();
    const sha = await git(work, "rev-parse", "HEAD");
    expect((await runGuard(work, "v3.0.0", sha)).code).toBe(1);
  });

  // A dispatched prerelease has no tag yet; `gh release create --target` makes it at this run's commit.
  test("a dispatch whose tag does not exist yet passes", async () => {
    const work = await gitRepoWithRemote();
    const sha = await git(work, "rev-parse", "HEAD");
    const { code, stdout } = await runGuard(work, "v3.0.0-beta.1", sha, "branch");
    expect(code).toBe(0);
    expect(stdout).toContain("does not exist yet");
  });

  test("a dispatch whose tag already names another commit fails, since tag names are one-use", async () => {
    const work = await gitRepoWithRemote();
    const original = await git(work, "rev-parse", "HEAD");
    await git(work, "tag", "v3.0.0-beta.1");
    await git(work, "push", "-q", "origin", "refs/tags/v3.0.0-beta.1");
    await commit(work, "later work");
    const later = await git(work, "rev-parse", "HEAD");
    expect(later).not.toBe(original);
    expect((await runGuard(work, "v3.0.0-beta.1", later, "branch")).code).toBe(1);
  });
});
