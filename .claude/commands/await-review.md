---
description: Wait for CI + Greptile to cover a PR's latest head SHA, then summarize the verdict and any P1/P2 findings.
argument-hint: "[pr-number] (defaults to the current branch's PR)"
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr diff:*), Bash(gh api:*), Bash(git rev-parse:*)
---

Wait for CI **and** Greptile to finish on the PR's **latest head SHA**, then report whether it's green/reviewed or still pending. This enforces the repo's "GREPTILE PR REVIEW IS A GATE" rule: never stop at the PR URL — confirm the latest commit is actually covered.

Arguments: `$ARGUMENTS` → optional PR number. If omitted, resolve the PR for the current branch (`gh pr view --json number`).

## Steps

1. Read the PR and its **current head SHA** in one call (`<N>` is the PR number):
   ```bash
   gh pr view <N> -R drakulavich/kesha-voice-kit --json number,headRefOid,mergeStateStatus
   ```

2. Block on the checks rather than polling them — each poll's table is context you pay for, and `--watch` returns once they settle:
   ```bash
   gh pr checks <N> -R drakulavich/kesha-voice-kit --watch --fail-fast --interval 30 > /dev/null
   ```

3. Ask once for what is not green, and for Greptile's state on **that same SHA**:
   ```bash
   gh pr checks <N> -R drakulavich/kesha-voice-kit --json name,state,link \
     --jq '.[] | select(.state != "SUCCESS" and .state != "SKIPPED")'
   gh pr view <N> -R drakulavich/kesha-voice-kit --json reviews,comments \
     --jq '[.reviews[], .comments[] | select(.author.login | test("greptile"; "i"))] | .[-3:]'
   ```
   An empty Greptile `conclusion` means it is still reading the new SHA even if a stale pass shows; do **not** trust a pass whose timestamp predates the latest push. If the head SHA changed while you waited, start again at step 1 — the answer is about the old commit.

4. State plainly: is the **latest head SHA** green + reviewed, or still waiting? List every **P1/P2** as a merge blocker (or note a clear false positive to dismiss with a comment). **Never gate on the Confidence Score** — 9 of 30 PRs scored 5/5 while carrying Greptile's own P1/P2. Greptile silent → say so and carry on.

Reference: CLAUDE.md "GREPTILE PR REVIEW IS A GATE".
