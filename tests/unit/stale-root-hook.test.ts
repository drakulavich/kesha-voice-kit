import { describe, expect, test } from "bun:test";
import { staleRootNotice } from "../../.claude/hooks/stale-root";

const ROOT = "/repos/kesha-voice-kit";

describe("staleRootNotice", () => {
  test("says nothing when the root checkout is up to date", () => {
    expect(staleRootNotice(0, ROOT)).toBeNull();
  });

  test("names the count and the fast-forward to run in the root checkout", () => {
    const notice = staleRootNotice(2, ROOT);
    expect(notice?.systemMessage).toBe(
      `The root checkout ${ROOT} is 2 commits behind origin/main, so its CLAUDE.md may be stale. ` +
        `Fast-forward it: cd ${ROOT} && git fetch origin && git merge --ff-only origin/main`,
    );
    expect(notice?.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: notice!.systemMessage });
  });

  test("uses the singular for one commit", () => {
    expect(staleRootNotice(1, ROOT)?.systemMessage).toContain("is 1 commit behind origin/main");
  });
});
