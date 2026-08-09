import { afterEach, describe, expect, test } from "bun:test";
import { cleanupGitRepos, commit, git, gitRepoWithRemote } from "../helpers/git-repo";
import { repoPath } from "../helpers/repo";

const SCRIPT = repoPath(".github/scripts/push-annotated-tag.sh");

afterEach(cleanupGitRepos);

async function pushTag(work: string, message: string, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: work,
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(message),
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited;
}

describe("push-annotated-tag.sh", () => {
  // Default cleanup strips them, and an engine release body is written in headings (#651).
  test("keeps heading lines the release body needs", async () => {
    const work = await gitRepoWithRemote();
    const notes = "# Engine v1.24.8\n\n## Features\n\n- something\n";

    expect(await pushTag(work, notes, { TAG: "v1.24.8" })).toBe(0);
    expect(await git(work, "tag", "-l", "--format=%(contents)", "v1.24.8")).toContain("# Engine v1.24.8");
    expect(await git(work, "tag", "-l", "--format=%(contents)", "v1.24.8")).toContain("## Features");
  });

  test("annotates rather than leaving a lightweight tag", async () => {
    const work = await gitRepoWithRemote();
    await pushTag(work, "notes\n", { TAG: "v1.24.8" });

    expect(await git(work, "for-each-ref", "refs/tags/v1.24.8", "--format=%(objecttype)")).toBe("tag");
  });

  test("pushes the tag to origin", async () => {
    const work = await gitRepoWithRemote();
    await pushTag(work, "notes\n", { TAG: "v1.24.8" });

    expect(await git(work, "ls-remote", "--tags", "origin")).toContain("refs/tags/v1.24.8");
  });

  test("tags HEAD when no commit is named", async () => {
    const work = await gitRepoWithRemote();
    await commit(work, "later work");
    await pushTag(work, "notes\n", { TAG: "v1.24.8" });

    expect(await git(work, "rev-list", "-n", "1", "v1.24.8")).toBe(await git(work, "rev-parse", "HEAD"));
  });

  test("tags the named commit when one is given", async () => {
    const work = await gitRepoWithRemote();
    const first = await git(work, "rev-parse", "HEAD");
    await commit(work, "later work");
    await pushTag(work, "notes\n", { TAG: "v1.24.8", SHA: first });

    expect(await git(work, "rev-list", "-n", "1", "v1.24.8")).toBe(first);
  });

  // The message reaches git through stdin; argv would re-expose what `env:` protects (#291).
  test("keeps shell metacharacters in the message literal", async () => {
    const work = await gitRepoWithRemote();
    await pushTag(work, "notes $(touch pwned) and `touch pwned2`\n", { TAG: "v1.24.8" });

    expect(await git(work, "tag", "-l", "--format=%(contents)", "v1.24.8")).toContain("$(touch pwned)");
    expect(await Bun.file(`${work}/pwned`).exists()).toBe(false);
    expect(await Bun.file(`${work}/pwned2`).exists()).toBe(false);
  });
});
