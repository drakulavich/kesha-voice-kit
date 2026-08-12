---
description: Create a gitignored worktree off fresh origin/main per CLAUDE.md's "MAIN STAYS IN ROOT" rule.
argument-hint: "<slug> [branch-name]"
allowed-tools: Bash(just:*)
---

Run `just worktree <slug> [branch]` from the **root checkout** and report where the new tree landed.

Arguments: `$ARGUMENTS` → first token is `<slug>` (required), optional second token is the branch name. If the slug is missing, ask for it and stop.

The recipe owns the ritual — fetching `origin/main`, branching off it rather than off the possibly-stale local `main`, and refusing to run from inside an existing worktree. Do not reconstruct the `git worktree` commands here or reach past it.

- The branch defaults to the slug (slug `vad-fix` → branch `vad-fix`).
- If the recipe refuses because you are inside a worktree, `cd` to the root checkout and rerun; do **not** work around it.
- If the branch already exists, `git worktree add -b` fails — report that rather than picking another name.

Then tell the user to `cd .worktrees/<slug>`, and that edit/test/commit/PR all happen inside the worktree while cleanup (`just worktree-rm <slug>`) happens back in the root checkout.

Reference: the `worktree` recipe in `justfile`, CLAUDE.md "MAIN STAYS IN THE ROOT CHECKOUT".
