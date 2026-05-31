---
description: Wait for CI + Greptile to cover a PR's latest head SHA, then summarize the verdict and any P1/P2 findings.
argument-hint: "[pr-number] (defaults to the current branch's PR)"
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr diff:*), Bash(gh api:*), Bash(git rev-parse:*)
---

Wait for CI **and** Greptile to finish on the PR's **latest head SHA**, then report whether it's green/reviewed or still pending. This enforces the repo's "GREPTILE PR REVIEW IS A GATE" rule: never stop at the PR URL — confirm the latest commit is actually covered.

Arguments: `$ARGUMENTS` → optional PR number. If omitted, resolve the PR for the current branch (`gh pr view --json number`).

## Steps

1. Resolve the PR number and capture the **current head SHA**:
   ```bash
   gh pr view <N> -R drakulavich/kesha-voice-kit --json number,headRefOid,mergeStateStatus
   ```

2. Poll until both CI and Greptile are non-pending **on that head SHA**. Use a background poll so you don't block the session — re-check every ~50s, up to ~20 min. Parse `gh pr checks <N>` (tab-separated: name TAB state); for Greptile, also confirm via `gh pr view --json statusCheckRollup` that its `conclusion` is set (an empty conclusion = still reviewing the new SHA, even if a stale pass shows). Do **not** trust a pass whose timestamp predates the latest push.

3. When both settle, summarize:
   - CI: which jobs passed / failed / were skipped (path-filtered jobs skipping is normal for docs-only PRs).
   - Greptile: the top-level summary and every inline **P1/P2** finding (treat these as merge blockers). Pull them via `gh pr view <N> --json reviews,comments` filtering authors matching `greptile`.

4. State plainly: is the **latest head SHA** green + reviewed, or still waiting? If there are P1/P2 findings, list them as the blockers to fix before merge (or note a clear false positive to dismiss with a comment).

Reference: CLAUDE.md "GREPTILE PR REVIEW IS A GATE".
