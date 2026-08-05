import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupGitRepos, commit, git, gitRepoWithRemote } from "../helpers/git-repo";

const SCRIPT = `${import.meta.dir}/../../.github/scripts/alpha-tag.sh`;

afterEach(cleanupGitRepos);

async function runTag(work: string, tag: string, previous: string): Promise<string> {
  const sha = await git(work, "rev-parse", "HEAD");
  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: work,
    env: { ...process.env, TAG: tag, SHA: sha, PREVIOUS: previous },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`alpha-tag.sh failed: ${await new Response(proc.stderr).text()}`);
  }
  return git(work, "tag", "-l", "--format=%(contents)", tag);
}

describe("alpha-tag.sh", () => {
  test("lists the commits since an ancestral baseline", async () => {
    const work = await gitRepoWithRemote();
    await git(work, "tag", "v1.26.0-cli");
    await commit(work, "first change");
    await commit(work, "second change");

    const message = await runTag(work, "v1.27.0-alpha.1-cli", "v1.26.0-cli");

    expect(message).toContain("Commits since v1.26.0-cli:");
    expect(message).toContain("- second change");
    expect(message).toContain("- first change");
  });

  test("pushes the tag it created", async () => {
    const work = await gitRepoWithRemote();
    await git(work, "tag", "v1.26.0-cli");
    await commit(work, "change");
    await runTag(work, "v1.27.0-alpha.1-cli", "v1.26.0-cli");

    expect(await git(work, "ls-remote", "--tags", "origin")).toContain("v1.27.0-alpha.1-cli");
  });

  // A baseline off this history would date the range wrongly rather than merely oddly.
  test("falls back to a reachable tag when the baseline is not an ancestor", async () => {
    const work = await gitRepoWithRemote();
    await git(work, "tag", "v1.26.0-cli");
    await git(work, "checkout", "-qb", "other");
    await commit(work, "other branch work");
    await git(work, "tag", "v1.28.0-cli");
    await git(work, "checkout", "-q", "-");
    await commit(work, "mainline work");

    const message = await runTag(work, "v1.29.0-alpha.1-cli", "v1.28.0-cli");

    expect(message).toContain("Commits since v1.26.0-cli:");
    expect(message).toContain("- mainline work");
    expect(message).not.toContain("other branch work");
  });

  test("ignores tags that are not releases of this channel", async () => {
    const work = await gitRepoWithRemote();
    await git(work, "tag", "v1.26.0-cli");
    await commit(work, "tagged by something else");
    await git(work, "tag", "audio-244");
    await git(work, "tag", "v1.24.7");
    await commit(work, "mainline work");

    const message = await runTag(work, "v1.29.0-alpha.1-cli", "v9.9.9-cli");

    expect(message).toContain("Commits since v1.26.0-cli:");
  });

  test("says there is nothing to count from when no release tag is reachable", async () => {
    const work = await gitRepoWithRemote();
    await commit(work, "only change");

    const message = await runTag(work, "v1.27.0-alpha.1-cli", "");

    expect(message).toContain("No earlier tag in this commit's history to count from.");
  });

  // Subjects reach git tag through -F -, never through the shell.
  test("keeps shell metacharacters in a commit subject literal", async () => {
    const work = await gitRepoWithRemote();
    await git(work, "tag", "v1.26.0-cli");
    await commit(work, "fix: $(touch pwned) and `touch pwned2`");

    const message = await runTag(work, "v1.27.0-alpha.1-cli", "v1.26.0-cli");

    expect(message).toContain("fix: $(touch pwned) and `touch pwned2`");
    expect(await Bun.file(join(work, "pwned")).exists()).toBe(false);
    expect(await Bun.file(join(work, "pwned2")).exists()).toBe(false);
  });
});
