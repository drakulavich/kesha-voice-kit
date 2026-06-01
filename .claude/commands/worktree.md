---
description: Create a gitignored worktree off fresh origin/main per CLAUDE.md's "MAIN STAYS IN ROOT" rule.
argument-hint: "<slug> [branch-name]"
allowed-tools: Bash(git fetch:*), Bash(git worktree:*), Bash(git branch:*), Bash(git rev-parse:*)
---

Create an isolated worktree for new work, strictly following the repo's "MAIN STAYS IN THE ROOT CHECKOUT — AGENTS EDIT ONLY IN WORKTREES" rule. **Never** switch the root checkout to a feature branch; **never** branch off the (possibly stale) local `main`.

Arguments: `$ARGUMENTS` → first token is `<slug>` (required), optional second token is the branch name.

## Steps

1. Parse `<slug>` (required) and the optional branch. If no branch given, default to the slug (e.g. slug `vad-fix` → branch `vad-fix`). If the slug is missing, ask for it and stop.

2. Confirm you are in the **root checkout** (not already inside `.worktrees/`): `git rev-parse --show-toplevel`. If inside a worktree, cd to the root checkout first.

3. Branch off **fresh** `origin/main`:
   ```bash
   git fetch origin main
   git worktree add .worktrees/<slug> -b <branch> origin/main
   ```
   If the branch already exists, stop and report rather than clobbering.

4. Print the next step for the user:
   ```
   cd .worktrees/<slug>
   ```
   and remind that edit/test/commit/PR all happen inside the worktree, and cleanup after merge is:
   ```
   git worktree remove .worktrees/<slug> && git worktree prune
   ```

Reference: CLAUDE.md "MAIN STAYS IN THE ROOT CHECKOUT".
