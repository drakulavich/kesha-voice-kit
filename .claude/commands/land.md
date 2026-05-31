---
description: Land a green PR — verify CI+Greptile on head SHA, confirm issue linkage, merge, and clean up the worktree.
argument-hint: "[pr-number] (defaults to the current branch's PR)"
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr merge:*), Bash(gh issue view:*), Bash(gh issue close:*), Bash(git worktree:*), Bash(git rev-parse:*)
---

Finish and merge a PR safely, enforcing the repo's review gate, issue-linkage, and worktree-cleanup rules. **Do not merge** unless CI and Greptile are both green on the latest head SHA.

Arguments: `$ARGUMENTS` → optional PR number (defaults to the current branch's PR).

## Steps

1. Resolve the PR and its current head SHA:
   ```bash
   gh pr view <N> -R drakulavich/kesha-voice-kit --json number,headRefOid,mergeStateStatus,body,headRefName,closingIssuesReferences
   ```

2. **Gate — refuse to merge if not satisfied:**
   - CI checks all passing/skipped on the head SHA (`gh pr checks <N>`).
   - Greptile review `conclusion` is success **on that head SHA** (not a stale pass — see `/await-review`). If P1/P2 findings are open, stop and list them.
   - `mergeStateStatus` is `CLEAN`.
   If any fails, report what's blocking and stop.

3. **Issue linkage:** confirm the PR body/commits contain a `Closes #N` / `Fixes #N` / `Resolves #N` keyword so the issue auto-closes. If the work fully addresses an issue but the keyword is missing, tell the user (don't silently merge a partial link). `Refs #N` is correct for partial work — in that case the issue should stay open.

4. **Merge** (match the repo's convention — squash unless told otherwise):
   ```bash
   gh pr merge <N> -R drakulavich/kesha-voice-kit --squash
   ```

5. **Clean up the worktree** for the merged branch (from the root checkout):
   ```bash
   git worktree remove .worktrees/<slug> && git worktree prune
   ```

6. **Verify the issue actually closed** (auto-close can lag for partial links). If it should be closed but isn't:
   ```bash
   gh issue view <N> -R drakulavich/kesha-voice-kit --json state
   gh issue close <N> -R drakulavich/kesha-voice-kit --comment "Landed in #<N>."
   ```
   The `WIP` label is removed automatically on merge; if it lingers, remove it.

Reference: CLAUDE.md "GREPTILE PR REVIEW IS A GATE", "LINK PRS TO ISSUES", "MAIN STAYS IN THE ROOT CHECKOUT".
