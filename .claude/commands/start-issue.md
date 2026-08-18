---
description: Pick up a GitHub issue — tag it WIP and spin up a worktree off fresh origin/main.
argument-hint: "<issue-number> [slug]"
allowed-tools: Bash(gh issue view:*), Bash(gh issue edit:*), Bash(gh label create:*), Bash(gh label list:*), Bash(just:*)
---

Start work on a GitHub issue, following the repo's "FLAG ACTIVE WORK WITH A WIP LABEL" and worktree rules in one step.

Arguments: `$ARGUMENTS` → first token is the issue number (required), optional second token is a worktree slug (default `issue-<N>`).

## Steps

1. Read the issue and summarize its acceptance criteria for the user:
   ```bash
   gh issue view <N> -R drakulavich/kesha-voice-kit
   ```

2. Tag it `WIP` so drakulavich sees it's in flight. Create the label first only if it doesn't exist:
   ```bash
   gh label create WIP -R drakulavich/kesha-voice-kit --color FBCA04 \
     --description "An agent or contributor is actively working on this" 2>/dev/null || true
   gh issue edit <N> -R drakulavich/kesha-voice-kit --add-label WIP
   ```

3. Create the worktree from the root checkout — the recipe fetches `origin/main` and branches off it, never off local main:
   ```bash
   just worktree <slug> fix/issue-<N>
   ```
   Pick a descriptive branch prefix (`fix/`, `feat/`, `chore/`) based on the issue type.

4. Tell the user to `cd .worktrees/<slug>` and remind them: link the PR back with `Closes #<N>` in the body, and the WIP label is removed automatically when that PR merges (or run `gh issue edit <N> --remove-label WIP` if abandoned).

Reference: CLAUDE.md "FLAG ACTIVE WORK WITH A WIP LABEL", "LINK PRS TO ISSUES", "MAIN STAYS IN THE ROOT CHECKOUT".
