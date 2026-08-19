# Backlog Conveyor Review Runbook

The mandatory review sequence for every PR the backlog conveyor produces.
`CLAUDE.md` carries the binding invariant; this file says what the durable
GitHub evidence must contain.

## 1. Review every PR, aimed at a claim

Run `just review "<claim>"` the moment the PR exists, and block on it with the
`just review-wait <log>` line it prints — the reviewer detaches, and polling its
growing log costs the whole file every time you look. Measured over
#1016–#1064, **13 of 30 merged PRs (43%) were never reviewed at all**, while
every P1/P2 the reviews did raise led to a code change — 6 for 6. Coverage,
not wording, is what the gate was losing.

The prompt is a claim **plus a standing sweep**. The claim focuses; measured over three PRs on
2026-08-18 it also *narrowed*, and every later round found what a different question would have
surfaced first rather than what a closer reading would have. The sweep — second-order
consequences, both mutations per guard, the lane that runs each new test, this repo's recurring
classes, and an explicit statement of what went unexamined — is what stops the claim bounding
the review. It lives in `scripts/review-prompt.ts` so it can be pinned by a test.

`CLAIM` is required by the recipe on purpose. Reviews framed as *refute this
specific claim* found defects that "review this PR" did not, including two false
assertions their own author had written down with confidence.

Post one comment headed `**grok review**` containing:

- the **full** head SHA;
- the verdict; and
- every material finding with its severity and enough context for a fresh fix
  agent to act on it — or an explicit `No material findings`.

Greptile reviews on its own trigger. It is complementary, not redundant:
across #753–#800 both reviewers saw 13 PRs, and only 4 of the 9 productive
ones were found by both — dropping either loses more than half. When silent,
say so in the comment and carry on; never block on it.

**Never gate on Greptile's Confidence Score.** Nine of those thirty PRs scored
`5/5` "safe to merge" while carrying Greptile's own P1/P2 inline findings,
#775 with two P1 among them. Gate on findings.

## 2. Resolve findings in a later pass

Every confirmed P1/P2 blocks `merge-ready`, whoever raised it and whatever any
quota is doing. Remove the label first if it is present, then hand the finding
comment verbatim to a fix pass. The new head restarts step 1.

Rejecting a finding takes a PR comment naming the current head SHA and evidence
a fresh agent can verify. Silence is not dismissal. After three unresolved
rounds, post what remains, label the issue `needs-decision`, and stop.

P3 findings stay recorded in the review comment and are handled when their risk
warrants it.

## 3. Mark `merge-ready`

Only through
`bun run conveyor -- gate --issue <N> --pr <PR> --evidence <path> --apply`,
which binds the label to the current head before applying it. Never add it by
hand — a hand-applied label is reported as stale evidence by `sync` within
minutes, and `gate` cannot express a PR that closes no issue, so a dependabot
bump gets its verdict in a comment and no label at all.

Any later push removes `merge-ready` and restarts this runbook.
