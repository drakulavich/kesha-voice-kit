# Replace the internal backlog conveyor with the standalone `conveyor`

Status: approved design, pending implementation plan.
Scope: two repositories — `drakulavich/conveyor` (one prerequisite PR) and
`drakulavich/kesha-voice-kit` (one cutover PR plus out-of-PR state seeding).

## Context

kesha's internal conveyor (`scripts/backlog-conveyor.ts` and satellites) is the
ancestor of the standalone tool at `~/personal/repos/conveyor`. Same DNA — exit
codes 0/2/3/4 with refusal outranking violation, `--apply` gating, SHA-bound
gate evidence with digest, marker comment, pure evaluators over injected facts —
but the standalone version has since grown what kesha deliberately cut and then
rebuilt need for: a hand-ordered local queue (`next`), lanes, a config profile,
`evidence` and `review-prompt` as subcommands, and a repo-agnostic `bin`.

Decisions taken during brainstorming, in order:

1. **Full transition** to the standalone model — not a code-only swap under the
   old label-driven process.
2. **Consumption**: a locally available `conveyor` command (`bun link` from the
   sibling checkout) plus a `conveyor.config.json` inside the kesha repo root.
   The tool finds the profile at the repository root of its cwd on its own
   (`conveyor src/profiles/config.ts:54-63`); no env var, no justfile glue.
3. **Labels `WIP` and `merge-ready` are dropped.** In-flight state becomes the
   queue plus worktree plus open PR; the merge verdict becomes the gate marker
   comment. `needs-decision` survives as the profile's `blockedLabel`. The
   visible "human may merge" signal moves into the marker comment itself —
   which is conveyor#35, promoted to a prerequisite of this migration.
4. **No justfile wrappers for conveyor commands.** The loop's operator is an
   agent with direct access to the `conveyor` command; recipes that merely
   re-spell its subcommands are a layer that can only drift. (Revised during
   review of the design: the earlier draft kept `just gate` / `just review` as
   thin wrappers.)

Cutover timing is favorable and was verified: 0 issues carry `WIP`, 0 PRs carry
`merge-ready`, 15 open issues, 1 open PR, 17 worktrees (mostly stale spikes).

## Part 1 — prerequisite PR in `conveyor`: close #35

The gate's terminal comment currently renders as an empty bubble (marker only).
kesha loses its visible merge signal with the `merge-ready` label, so the
marker must carry one.

**Comment format** becomes exactly two parts:

```
Gate: PR #<pr> closes #<issue> — evidence bound to head <sha>, <provider>, <uri>

<!-- conveyor-gate:v1 {"version":1,...} -->
```

**Parse rule preserving G2** (`src/core/evidence.ts:84-86` — a quote-reply of a
marker once counted as a marker for the wrong head): the marker is the **last
line** of the trimmed body, and that line must start with `MARKER_PREFIX` and
end with `MARKER_SUFFIX`. A quote-reply fails (its line starts with `> `).
Legacy marker-only bodies parse unchanged (last line == whole body), so
existing markers — conveyor's own and kesha's old internal ones — stay
readable.

**Changes**: `encodeGateMarker` unchanged; new `composeGateComment(marker)`
renders visible line + blank line + marker; `src/core/actions.ts:23` switches
to it; `parseGateMarker` adopts the last-line rule. No evaluator changes.

**Pinned in both directions, mutations aimed at the outermost layer**
(CLAUDE.md doctrine landed in conveyor#48):

- Mutate the wiring — `actions.ts` back to bare `encodeGateMarker` — and a test
  asserting the visible line inside the composed POST argv goes red.
- Mutate the parser to accept a marker anywhere in the body, and a quote-reply
  test (`> `-prefixed marker line must yield `null`) goes red. G2 moves from a
  comment into a test.
- A marker-only body must parse (legacy); mutate the parser to require two
  parts and that test goes red.

Queue slotting for #35 is the maintainer's hand (the lane-a session suggested a
slot after #44 and #53; #44 and #48 have merged to main, #53's status was not
checked here).

## Part 2 — cutover PR in kesha

**Deleted** (taking the narrowing's dead code — `QueueIssue`, `mapBounded`,
`pagedArray`, `loadCollisionIssues` — with it):

- `scripts/backlog.ts`, `scripts/backlog-conveyor.ts`,
  `scripts/gate-evidence.ts`, `scripts/review-prompt.ts`
- `tests/unit/backlog-conveyor.test.ts`, `tests/unit/gate-evidence.test.ts`,
  `tests/unit/review-prompt.test.ts`
- `package.json` script `"conveyor": "bun scripts/backlog.ts"`
- `.claude/commands/{start-issue,land,await-review}.md` — the pre-conveyor
  hand-driven loop with a hardcoded repo. (`worktree.md` and `preflight.md`
  stay: verification, not conveyor.)
- justfile recipes `gate` and `review` — deleted, not rewritten (decision 4).
  `worktree`, `worktree-rm`, `preflight`, `mutate` stay untouched.
  `tests/unit/check-recipes.test.ts` loses the deleted recipes' pins; no new
  recipe bodies are added, so the pipefail contract of #1085/#1086 concerns
  only the surviving recipes.

**Rewritten:**

- `docs/runbooks/backlog-conveyor.md` + `-review.md` → one
  `docs/runbooks/conveyor.md` that is a **pointer plus deltas, not a copy**:
  the canonical loop is the conveyor repo's `RUNBOOK.md` (available in the
  sibling checkout the `conveyor` command comes from), and this file records
  only what kesha does differently. A second full copy is exactly the
  doc-drift class conveyor#49 paid two review rounds to discover. The deltas:
  - Reviewer: `conveyor review-prompt … --claim "<claim>" | omc ask grok -p`
    launched in the background, log to `.omc/review-<pr>-<sha8>.log`; the
    durable `**grok review**` comment contract (full head SHA, every finding)
    carries over. Greptile remains the trigger-driven second reviewer, never
    gated on its Confidence Score.
  - Worktrees are created with `just worktree <slug> <branch>` (the
    `root-checkout-only` guard is kesha's).
  - Verification gates are `just preflight` / `just mutate`.
- `CLAUDE.md` "BACKLOG CONVEYOR REVIEW GATE": `merge-ready` replaced by the
  visible gate-comment line bound to the head SHA; `bun run conveyor --`
  replaced by `conveyor`; points at the new runbook.
- `.claude/agents/`: copy only `bug-fixer` from the conveyor repo — the one
  agent the profile's `agentByLabel` names. `pr-reviewer` is not needed (kesha
  reviews with grok + Greptile, not a reviewer agent) and `test-author` waits
  for the first `testing`-labelled ticket. An agent brief arrives when a
  mapping names it, not before.

**Untouched:** `scripts/mutate.ts`, `scripts/mutants-ts.ts`; the
`needs-decision` label. The `WIP` and `merge-ready` GitHub labels are deleted
from the repository so nobody re-applies them from memory (they hang on
nothing — verified 0/0).

**Ordering:** this PR merges only after Part 1 is merged; otherwise the
visible merge signal disappears with the label without reappearing in the
marker.

## Part 3 — kesha profile and queue seeding

`conveyor.config.json` at the kesha root, gitignored (one operator; no
committed example). First edition:

```json
{
  "repo": "drakulavich/kesha-voice-kit",
  "defaultBranch": "main",
  "worktreeDir": ".worktrees",
  "criticalChecks": ["🧪 CI", "🧪 Rust Tests", "🛡️ Security Audit"],
  "mustRunWhenTouched": [
    { "paths": ["rust/**"], "checks": ["🧪 Rust Tests"] }
  ],
  "testGate": [{ "source": ["src/**"], "requiresTests": ["tests/**"] }],
  "reviewers": [],
  "recurringDefects": [
    "a closing keyword naming the wrong issue",
    "a consumer-facing document left stale while the spec was updated",
    "an assertion re-pointed at broken output rather than the change being wrong",
    "a fix that recreates its defect one level up",
    "a new branch that swallows an unrelated failure"
  ],
  "assignee": "drakulavich",
  "blockedLabel": "needs-decision",
  "agentByLabel": { "bug": { "agent": "bug-fixer", "model": "opus" } },
  "branchPrefixByLabel": { "bug": "fix", "enhancement": "feat" },
  "defaultBranchPrefix": "chore"
}
```

Notes:

- The old `SWEEP` migrates cleanly: the standalone `src/review/prompt.ts`
  already carries Second-order / Guards / Reach / Completeness verbatim; only
  the recurring-classes line is kesha-specific, and it becomes
  `recurringDefects` (the five entries above are that line, split).
- `criticalChecks` are the branch-protection names verbatim, emoji included —
  read from the API, not retyped.
- `reviewers: []` — review here is a CLI reviewer, not GitHub review requests.
  If the profile validator rejects an empty list, that is a conveyor ticket,
  not a kesha workaround.

**Queue seeding** (outside the PR — state lives in the conveyor checkout):
`state/drakulavich--kesha-voice-kit/queue.txt`, drafted oldest-first from the
15 open issues, then hand-reordered by the maintainer. One lane, no lane
files: no parallel kesha sessions exist, and lane files appear when they are
needed (conveyor #42 doctrine).

## Part 4 — rollout, cleanup, and what pins the migration

Order:

1. Conveyor PR for #35, through conveyor's own loop.
2. `bun link` in the conveyor checkout; verify `conveyor next` runs from kesha
   (dry-run, reads only).
3. Local `conveyor.config.json` in kesha (gitignored, does not wait for the PR).
4. Cutover PR — reviewed with the new tool itself:
   `conveyor review-prompt | omc ask grok -p`. The PR that deletes the old
   conveyor is the new one's first real engagement.
5. Seed the queue; maintainer hand-orders it.
6. Worktree cleanup: `conveyor sync` (dry-run) lists findings over the 17
   worktrees (slug-named spikes will read as orphans); the maintainer approves
   the kill list; `just worktree-rm` each; done when `sync` converges to zero
   proposed actions — the same convergence its ancestor showed (71 → 0).
7. Acceptance: one real ticket driven through the full loop
   (next → work → review → gate → close). That run is the evidence the
   replacement happened.

**Verifying the deletion** — by the lesson both repositories carry: the check
must not share its source of truth with the fix. The scrub list derives from
what the end state must NOT contain — `backlog-conveyor`, `backlog.ts`,
`gate-evidence`, `review-prompt.ts`, `merge-ready`, `WIP`, `bun run conveyor`,
`just gate`, `just review` — and runs against a **fresh clone**, excluding
`openspec/changes/` and `docs/plans/completed/` (history stays history).

**Risks, named up front:**

- `reviewers: []` may fail profile validation → conveyor ticket.
- Emoji check names must survive `gh api` → facts → evaluator; settled by the
  first dry-run `conveyor gate` against a real kesha PR.
- Old kesha gate markers must parse under the new last-line rule; covered by
  Part 1's legacy test.
- `agentByLabel` references copied agent briefs; the cutover PR must not merge
  with a mapping that names an agent absent from `.claude/agents/`.
