---
description: Land a green PR — verify CI+Greptile on head SHA, confirm issue linkage, merge, and clean up the worktree.
argument-hint: "[pr-number] (defaults to the current branch's PR)"
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr merge:*), Bash(gh issue view:*), Bash(gh issue close:*), Bash(bun run:*), Bash(just:*), Bash(git rev-parse:*)
---

Finish and merge a PR safely. The mergeability rules are **code**, not prose here: `just gate` refuses an unmerged head that fails any of them. Do not re-derive them with `gh` — run the gate and read its violations.

Arguments: `$ARGUMENTS` → optional PR number (defaults to the current branch's PR).

## Steps

1. Resolve the PR (`<PR_N>`), its head SHA, and the issue it closes:
   ```bash
   gh pr view <PR_N> -R drakulavich/kesha-voice-kit --json number,headRefOid,mergeStateStatus,headRefName,closingIssuesReferences
   ```
   No closing issue (a dependabot bump, say)? `gate` cannot express that PR: check it by hand, put the verdict in a comment, and apply no label.

2. **Gate.** `<PROVIDER>`/`<URI>` are the review that approved this head — the `**grok review**` comment's source and URL:
   ```bash
   just gate <ISSUE_N> <PR_N> <PROVIDER> <URI>
   ```
   It reads the head immediately before binding evidence to it and refuses unless the PR is open, non-draft, mergeable, based on the default branch, closes exactly `[<ISSUE_N>]`, carries no current-head `CHANGES_REQUESTED`, and every required check is terminally green. Any violation it prints is the blocker — report it and stop.

3. **Greptile is a separate gate** the conveyor does not see: open **P1/P2** findings on the current head block the merge whatever the gate said, and never gate on the Confidence Score. See `/await-review`.

4. **Merge** (squash unless told otherwise). `--delete-branch` removes the remote feature branch regardless of the repo's auto-delete setting:
   ```bash
   gh pr merge <PR_N> -R drakulavich/kesha-voice-kit --squash --delete-branch
   ```

5. **Close** — from the **root checkout**, never from inside the worktree being removed:
   ```bash
   bun run conveyor -- close --issue <ISSUE_N> --pr <PR_N> --apply
   ```
   It removes the `WIP` label and the clean managed worktree, and refuses a dirty or unmanaged one rather than forcing it. It requires the issue to be closed already; GitHub's auto-close can lag a merge, so re-run it, or close by hand when the link was `Refs #N` rather than `Closes #N`:
   ```bash
   gh issue close <ISSUE_N> -R drakulavich/kesha-voice-kit --comment "Landed in #<PR_N>."
   ```

Reference: CLAUDE.md "GREPTILE PR REVIEW IS A GATE", "BACKLOG CONVEYOR REVIEW GATE", "MAIN STAYS IN THE ROOT CHECKOUT".
