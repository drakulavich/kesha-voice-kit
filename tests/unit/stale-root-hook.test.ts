import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { staleRootNotice } from "../../.claude/hooks/stale-root";
import { cleanupGitRepos, cloneFrom, commit, git, gitRepoWithRemote } from "../helpers/git-repo";
import { repoPath } from "../helpers/repo";

const HOOK = repoPath(".claude/hooks/stale-root.ts");

const ROOT = "/repos/kesha-voice-kit";
const onMain = { branch: "main", behind: 0, ahead: 0 };

describe("staleRootNotice", () => {
  test("says nothing when the root checkout is up to date", () => {
    expect(staleRootNotice(onMain, ROOT)).toBeNull();
  });

  test("names the count and the fast-forward to run in the root checkout", () => {
    const notice = staleRootNotice({ ...onMain, behind: 2 }, ROOT);
    expect(notice?.systemMessage).toBe(
      `The root checkout ${ROOT} is 2 commits behind origin/main, so its CLAUDE.md may be stale. ` +
        `Fast-forward it: cd '${ROOT}' && git fetch origin && git merge --ff-only origin/main`,
    );
    expect(notice?.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: notice!.systemMessage });
  });

  test("uses the singular for one commit", () => {
    expect(staleRootNotice({ ...onMain, behind: 1 }, ROOT)?.systemMessage).toContain("is 1 commit behind origin/main");
  });

  test("tells a root on another branch to switch back to main instead of fast-forwarding", () => {
    const message = staleRootNotice({ branch: "feat/x", behind: 3, ahead: 1 }, ROOT)?.systemMessage;
    expect(message).toBe(
      `The root checkout ${ROOT} is on feat/x rather than main, so its CLAUDE.md may not match main. ` +
        `Switch it back: cd '${ROOT}' && git switch main`,
    );
  });

  test("calls a detached HEAD out as not being on main", () => {
    expect(staleRootNotice({ branch: null, behind: 0, ahead: 0 }, ROOT)?.systemMessage).toContain("is on a detached HEAD rather than main");
  });

  test("reports a diverged main without suggesting a fast-forward that would fail", () => {
    const message = staleRootNotice({ branch: "main", behind: 2, ahead: 1 }, ROOT)?.systemMessage;
    expect(message).toBe(
      `The root checkout ${ROOT} has diverged from origin/main (1 commit ahead, 2 commits behind), so its CLAUDE.md may be stale ` +
        `and git merge --ff-only will fail. Reconcile main with origin/main by hand.`,
    );
  });

  test("quotes a root path with spaces and single quotes for a POSIX shell", () => {
    const message = staleRootNotice({ ...onMain, behind: 1 }, "/Users/a b/it's repo")?.systemMessage;
    expect(message).toContain(`cd '/Users/a b/it'\\''s repo' && git fetch origin`);
  });
});

describe("stale-root hook", () => {
  afterAll(cleanupGitRepos);

  async function run(cwd: string): Promise<string> {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const proc = Bun.spawn(["bun", HOOK], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out.trim();
  }

  async function rootWithWorktree(): Promise<{ root: string; worktree: string; upstream: string }> {
    const root = await gitRepoWithRemote();
    await git(root, "branch", "-M", "main");
    await git(root, "push", "-q", "-u", "origin", "main");
    await git(await git(root, "remote", "get-url", "origin"), "symbolic-ref", "HEAD", "refs/heads/main");
    const worktree = join(root, ".worktrees", "wt");
    await git(root, "worktree", "add", "-q", "-b", "wt", worktree);
    return { root, worktree, upstream: await cloneFrom(root) };
  }

  test("is silent from a worktree when the root checkout is up to date", async () => {
    const { worktree } = await rootWithWorktree();
    expect(await run(worktree)).toBe("");
  });

  test("warns from a worktree when origin/main has moved 2 commits past the root checkout", async () => {
    const { root, worktree, upstream } = await rootWithWorktree();
    await commit(upstream, "two");
    await commit(upstream, "three");
    await git(upstream, "push", "-q", "origin", "main");
    const out = JSON.parse(await run(worktree));
    const realRoot = realpathSync(root);
    expect(out.systemMessage).toBe(
      `The root checkout ${realRoot} is 2 commits behind origin/main, so its CLAUDE.md may be stale. ` +
        `Fast-forward it: cd '${realRoot}' && git fetch origin && git merge --ff-only origin/main`,
    );
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: out.systemMessage });
  });
});
