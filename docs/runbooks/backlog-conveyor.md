# Backlog Conveyor

One ticket at a time. State lives in GitHub and `bun run conveyor`; this file
holds only what a tool cannot decide. It is deliberately client-neutral —
Claude and Codex read this, not a client-specific command file.

## Loop

1. **Select** — `bun run conveyor -- sync` (`--apply` if it proposes repairs).
   Take the oldest open issue carrying neither `WIP` nor `needs-decision`.
   A question only the maintainer can answer gets a comment, `needs-decision`,
   and the next ticket — not an implementation run.

2. **Work** — `just worktree issue-<N>`, then one fresh-context agent, never
   reused across tickets. The brief gives coordinates rather than a search:
   `src/engine.ts:120-180` and the exact failing command, not "look at the
   engine code". `just preflight` prints one line per gate and the failing
   gate's output verbatim, so read what it prints rather than redirecting it.
   Blocked mid-flight? Push what exists, open a draft PR, comment the blocker,
   report `BLOCKED: <reason>`. Do not spin.

3. **Review — on every PR, no exceptions.** Launch it the moment the PR exists;
   the [review runbook](backlog-conveyor-review.md) names the command and what
   the comment must carry. 43% of merged PRs used to skip this entirely, and
   that gap cost more than any wording did.

4. **Fix** — every P1/P2 blocks; a rejection needs evidence a stranger can
   check. A new head restarts step 3. Three unresolved rounds →
   `needs-decision` and move on.

5. **Close** — `bun run conveyor -- gate --issue <N> --pr <P> --evidence <f> --apply`,
   then `close --issue <N> --pr <P> --apply`. Never apply a label by hand;
   `gate` cannot express a PR that closes no issue, so a dependabot bump gets
   its verdict in a comment and no label.

## The five that earned their place

- **Fresh context per ticket.** No counter-example across 65 pull requests.
- **Aim the review at a claim, not at the PR.** Three confident assertions
  turned out false in one day and each fell to "is that argument correct?";
  none would have surfaced from "review this PR".
- **Verify one decisive thing yourself.** "Gates green" was reported while
  `bunx tsc --noEmit` had 16 errors, and a green CI job never ran the test it
  existed for. One command settles it.
- **The conveyor is the state.** Hand-applied labels drift; one `sync` found 71.
- **Poll the remote, not the working copy.** A local snapshot called an agent
  stuck while its PR was open, and called `CLAUDE.md` current while it was 14
  commits behind. `git ls-remote`, `gh pr list --head`,
  `git show origin/main:<path>`.

Set model and effort once per session — changing either mid-run re-prefills the
whole conversation.
