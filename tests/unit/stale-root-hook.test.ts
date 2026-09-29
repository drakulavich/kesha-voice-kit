import { describe, expect, test } from "bun:test";
import { staleRootNotice } from "../../.claude/hooks/stale-root";

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
