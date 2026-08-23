# Conveyor Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace kesha-voice-kit's internal backlog conveyor with the standalone `conveyor` tool: one prerequisite PR in `~/personal/repos/conveyor` (closes conveyor#35), one cutover PR in kesha, then queue seeding, worktree cleanup, and a full-loop acceptance run.

**Architecture:** Phase A gives the conveyor's gate comment a visible line while preserving the G2 quote-reply protection (marker = last line only). Phase B deletes kesha's internal conveyor scripts and recipes, replaces two runbooks with a pointer-plus-deltas file, and configures the standalone tool via a gitignored profile at the kesha root.

**Tech Stack:** Bun + TypeScript in both repos; `gh` CLI; `just` in kesha. No new runtime dependencies anywhere.

**Spec:** `docs/superpowers/specs/2026-08-21-conveyor-migration-design.md` (kesha repo, committed at 5a6bdb0). The plan argues from the spec; executors read both.

## Global Constraints

- **conveyor repo:** never pin a real login, repository, branch or ticket title in committed source/tests/fixtures — tests read `exampleProfile` only. Every new rule pinned in both directions; the mutation attacks the outermost layer that can disable the rule (wiring, not body). Commit before any revert-to-red run: `git checkout <file>` restores HEAD, not your uncommitted fix. Verify with `bun test` + `bunx tsc --noEmit`.
- **kesha repo:** worktrees are created only from the root checkout (`just worktree`); `just preflight` before every push; every justfile recipe pipeline needs pipefail (tests #1085/#1086 enforce it — we add no recipes, only delete).
- Inline text-surgery scripts use `bun -e`, not python heredocs.
- Phase B Task 5 onward must not start until Phase A's PR is **merged** (spec Part 2, Ordering).
- Exit codes everywhere: 0 ok, 2 invariant violation, 3 operational failure, 4 unsafe refusal.

---

## Phase A — conveyor repo (closes conveyor#35)

**Maintainer gate before starting:** slot issue 35 into a lane file by hand (e.g. prepend `35` to `state/drakulavich--conveyor/queue.lane-b.txt`). Slicing an issue into a lane is the maintainer's hand, not the executor's.

### Task 1: `composeGateComment` and the last-line parse rule

**Files:**
- Modify: `src/core/evidence.ts` (marker codec, lines 80-100)
- Test: `tests/evidence.test.ts`

**Interfaces:**
- Consumes: existing `encodeGateMarker(marker: GateMarker): string`, `buildGateEvidence({provider, uri, headSha})`, `parseGateMarker(body: string): GateMarker | null`, `MARKER_PREFIX` / `MARKER_SUFFIX` constants.
- Produces: `composeGateComment(marker: GateMarker): string` — visible line, blank line, then `encodeGateMarker(marker)` as the final line. `parseGateMarker` keeps its signature; its rule becomes: the trimmed body's **last line** must start with `MARKER_PREFIX` and end with `MARKER_SUFFIX`.

- [ ] **Step 1: Write the failing tests** — append to `tests/evidence.test.ts`:

```ts
const composedMarker = {
  version: 1,
  issue: 21,
  pr: 30,
  evidence: buildGateEvidence({ provider: "grok", uri: "https://example.test/review", headSha: "a".repeat(40) }),
} as const;

test("composed comment leads with a visible line and ends with the marker", () => {
  const lines = composeGateComment(composedMarker).split("\n");
  expect(lines[0]!.startsWith("<!--")).toBe(false);
  expect(lines[0]).toContain("#30");
  expect(lines[0]).toContain("#21");
  expect(lines[0]).toContain("a".repeat(40));
  expect(lines[lines.length - 1]).toBe(encodeGateMarker(composedMarker));
});

test("a composed comment parses back to its marker", () => {
  expect(parseGateMarker(composeGateComment(composedMarker))).toEqual(composedMarker);
});

test("a marker-only body still parses (legacy)", () => {
  expect(parseGateMarker(encodeGateMarker(composedMarker))).toEqual(composedMarker);
});

test("a quote-reply of a composed comment is not a marker", () => {
  const quoted = composeGateComment(composedMarker).split("\n").map((line) => `> ${line}`).join("\n");
  expect(parseGateMarker(quoted)).toBeNull();
});
```

Add `composeGateComment` to the existing import from `../src/core/evidence`.

- [ ] **Step 2: Run to verify failure** — `bun test tests/evidence.test.ts`. Expected: FAIL — `composeGateComment` is not exported. **Check for a casualty:** if an existing test pins "marker must be the whole body" using a body whose *last line* is a valid marker (prose above, marker below), that test's expectation changes deliberately with this spec — rewrite it into the quote-reply form above rather than deleting it. A quoted marker must still fail.

- [ ] **Step 3: Implement** in `src/core/evidence.ts`:

```ts
export function composeGateComment(marker: GateMarker): string {
  const e = marker.evidence;
  const visible = `Gate: PR #${marker.pr} closes #${marker.issue} — evidence bound to head ${e.headSha}, ${e.provider}, ${e.uri}`;
  return `${visible}\n\n${encodeGateMarker(marker)}`;
}
```

In `parseGateMarker`, replace `const text = body.trim();` with:

```ts
  const lines = body.trim().split("\n");
  const text = lines[lines.length - 1]!.trim();
```

Everything below (prefix/suffix check, JSON parse, version/issue/pr guards) stays byte-identical. Update the G2 comment above the function: the rule is now "the last line, and nothing but the last line" — a quote-reply still fails because its lines start with `> `.

- [ ] **Step 4: Run to verify pass** — `bun test && bunx tsc --noEmit`. Expected: all green.

- [ ] **Step 5: Commit** — `git add src/core/evidence.ts tests/evidence.test.ts && git commit` — message: `gate comment carries a visible line; the marker is the last line, quote-replies still refused`.

### Task 2: wire `post-marker` to the composed comment

**Files:**
- Modify: `src/core/actions.ts:23`
- Test: `tests/actions.test.ts:29-36` (existing test "posts the marker as an issue comment on the pull request")

**Interfaces:**
- Consumes: `composeGateComment` from Task 1.
- Produces: the `post-marker` action POSTs `body=${composeGateComment(marker)}`.

- [ ] **Step 1: Change the test first** — in `tests/actions.test.ts`, import `composeGateComment` instead of relying only on `encodeGateMarker`, and change the expectation in the "posts the marker" test to:

```ts
    "gh", "api", "repos/o/r/issues/900/comments", "--method", "POST", "-f", `body=${composeGateComment(marker)}`,
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/actions.test.ts`. Expected: FAIL — actual body is the bare marker.

- [ ] **Step 3: Implement** — in `src/core/actions.ts`, change the import from `./evidence` to bring `composeGateComment`, and in line 23 replace `encodeGateMarker(action.marker)` with `composeGateComment(action.marker)`.

- [ ] **Step 4: Run to verify pass** — `bun test && bunx tsc --noEmit`. Expected: green.

- [ ] **Step 5: Commit** — `git add src/core/actions.ts tests/actions.test.ts && git commit` — message: `post-marker posts the composed comment, not the bare marker`.

### Task 3: mutation proof, PR, review round

**Files:** no new files; produces the PR and its mutation-evidence table.

- [ ] **Step 1: Run the three mutations** (tree is committed — Task 1/2 commits are the revert target). After each: run `bun test`, record which test went red, restore with `git checkout -- <file>`, re-run `bun test` green.
  - m1 (outer wiring): in `src/core/actions.ts` revert line 23 to `encodeGateMarker(action.marker)`. Expected red: `posts the marker as an issue comment on the pull request`.
  - m2 (parser scope): in `parseGateMarker` replace the last-line selection with a whole-body search — `const text = body.trim();` plus `const start = text.indexOf(MARKER_PREFIX); if (start === -1) return null; const text2 = text.slice(start);` and parse `text2`. Expected red: `a quote-reply of a composed comment is not a marker`.
  - m3 (visible half): make `composeGateComment` return `encodeGateMarker(marker)` only. Expected red: `composed comment leads with a visible line and ends with the marker`.

- [ ] **Step 2: Branch and push** — the work was done on a branch from the start if the RUNBOOK's worktree step was followed; otherwise `git checkout -b fix/35-visible-gate-marker && git push -u origin fix/35-visible-gate-marker`.

- [ ] **Step 3: Open the PR** — `gh pr create` with `Closes #35` and a body carrying: the two-part comment format, the mutation table (mutation → test that went red, from Step 1), deviations: none, docs updated: none (design.md §7 gains one sentence only if the reviewer asks — the spec of record for the format is #35 itself).

- [ ] **Step 4: Review per the conveyor RUNBOOK** — drive the repo's own review loop (review-prompt, reviewers, findings comment with head SHA). Per the maintainer's standing preference for this repo's loop: apply confirmed findings without asking, record applied/skipped in the PR comment, drive to ready.

- [ ] **Step 5: Human merges. Phase B unblocks only after the merge.**

---

## Phase B — kesha repo

### Task 4: link the command, write the profile, smoke-run (no commits)

**Files:**
- Create: `conveyor.config.json` at the kesha root (gitignored — the ignore entry itself lands in Task 5's branch).

- [ ] **Step 1: Link** — `cd ~/personal/repos/conveyor && bun link`. Verify: `which conveyor` resolves and `conveyor` with no args prints the usage line naming `next|sync|gate|close|evidence|review-prompt`.

- [ ] **Step 2: Write `conveyor.config.json`** at `~/personal/repos/kesha-voice-kit/conveyor.config.json` — exact content from spec Part 3 (repo `drakulavich/kesha-voice-kit`, the three emoji check names verbatim, `blockedLabel: "needs-decision"`, the five `recurringDefects`, `agentByLabel: { "bug": { "agent": "bug-fixer", "model": "opus" } }`, `reviewers: []`).

- [ ] **Step 3: Smoke** — `cd ~/personal/repos/kesha-voice-kit && conveyor sync`. Expected: dry-run report, exit 0 or 2, findings about existing worktrees are fine. If the profile validator rejects `reviewers: []`: stop, file a conveyor issue, fix it in conveyor (we own it) — do **not** put a fake reviewer in the profile.

### Task 5: cutover branch — delete the internal conveyor, write the delta runbook

**Files:**
- Delete: `scripts/backlog.ts`, `scripts/backlog-conveyor.ts`, `scripts/gate-evidence.ts`, `scripts/review-prompt.ts`, `tests/unit/backlog-conveyor.test.ts`, `tests/unit/gate-evidence.test.ts`, `tests/unit/review-prompt.test.ts`, `.claude/commands/start-issue.md`, `.claude/commands/land.md`, `.claude/commands/await-review.md`, `docs/runbooks/backlog-conveyor.md`, `docs/runbooks/backlog-conveyor-review.md`
- Modify: `package.json` (drop the `"conveyor"` script), `justfile` (delete recipes `review CLAIM` at ~:59-76 and `gate issue pr provider uri` at ~:83-90), `tests/unit/check-recipes.test.ts` (drop the deleted recipes' pins), `.gitignore` (add `conveyor.config.json`), `CLAUDE.md` (§ BACKLOG CONVEYOR REVIEW GATE)
- Create: `docs/runbooks/conveyor.md`, `.claude/agents/bug-fixer.md` (copied from `~/personal/repos/conveyor/.claude/agents/bug-fixer.md`, adapted only where it names conveyor-repo specifics)

**Interfaces:**
- Produces: `docs/runbooks/conveyor.md` is the file CLAUDE.md points at; Task 7 follows it.

- [ ] **Step 1: Worktree** — from the kesha root checkout: `just worktree standalone-conveyor feat/standalone-conveyor && cd .worktrees/standalone-conveyor`.

- [ ] **Step 2: Create the kesha tracking issue** — `gh issue create --title "Replace the internal backlog conveyor with the standalone tool" --body "Spec: docs/superpowers/specs/2026-08-21-conveyor-migration-design.md. One PR: delete scripts/backlog*, the gate/review recipes and the WIP/merge-ready vocabulary; point the runbook at the standalone RUNBOOK."` Record the number — the PR's `Closes #<N>` and the later `conveyor gate --issue <N>` both need it.

- [ ] **Step 3: Delete** — `git rm` every file in the Delete list; edit `package.json` to drop the `"conveyor"` script line; delete the two justfile recipes (whole recipe blocks including their comment lines); in `tests/unit/check-recipes.test.ts` remove the test cases that pin `review`/`gate` recipes (keep every other pin).

- [ ] **Step 4: Write `docs/runbooks/conveyor.md`:**

```markdown
# The conveyor loop

The loop is the standalone conveyor's RUNBOOK.md — read it in the checkout the
`conveyor` command comes from (`~/personal/repos/conveyor/RUNBOOK.md`). This
file records only what kesha does differently; for anything unstated, the
RUNBOOK is the text.

## Deltas

- **Profile and state**: `conveyor.config.json` at the kesha root (gitignored;
  never committed — it names the real repository and maintainer). Queue and
  state live in the conveyor checkout under `state/drakulavich--kesha-voice-kit/`.
- **Reviewer**: `conveyor review-prompt --pr <P> --claim "<claim>" | omc ask grok -p`,
  launched in the background, log at `.omc/review-<pr>-<sha8>.log`. Findings
  land as one `**grok review**` comment carrying the full head SHA and every
  material finding. Greptile is the trigger-driven second reviewer; its
  Confidence Score is never a gate.
- **Worktrees**: `just worktree <slug> <branch>` from the root checkout only;
  removed by `conveyor close --apply` for a queue ticket, `just worktree-rm <slug>`
  otherwise.
- **Verification**: `just preflight` before every push; `just mutate` for
  revert-to-red proof.
- **Gate and close**: `conveyor evidence <provider> <uri> --pr <P>`, then
  `conveyor gate --issue <N> --pr <P> --evidence <path> --apply`, then after a
  human merges, `conveyor close --issue <N> --pr <P> --apply`.
```

- [ ] **Step 5: Rewrite the CLAUDE.md section** — replace the `### BACKLOG CONVEYOR REVIEW GATE` block (currently CLAUDE.md:101-103) with:

```markdown
### CONVEYOR REVIEW GATE

Every conveyor-driven PR follows [the conveyor runbook](docs/runbooks/conveyor.md):
review via `conveyor review-prompt --pr <P> --claim "<claim>"` piped to the
reviewer the moment the PR exists, one durable comment carrying the full head
SHA and every finding, and a fix pass for confirmed blockers that restarts the
review on the new head. The merge verdict is the gate comment posted by
`conveyor gate … --apply` — its visible line binds the verdict to the head
SHA; never write one by hand. 43% of merged PRs used to skip the review
entirely — that gap cost more than any wording did, which is why the review
prompt takes the claim as a required argument.
```

- [ ] **Step 6: Copy the agent brief** — `cp ~/personal/repos/conveyor/.claude/agents/bug-fixer.md .claude/agents/bug-fixer.md`; read it; adapt only sentences that name the conveyor repo's own layout. Add `conveyor.config.json` to `.gitignore`.

- [ ] **Step 7: Verify** — `bun test` green (the deleted tests are gone, the surviving recipe pins pass), then `just preflight`. Expected: green; no Rust gate triggered (no `rust/` changes).

- [ ] **Step 8: Commit** — one commit: `refactor: replace the internal backlog conveyor with the standalone tool`, body naming the spec path and `Closes`-less (the PR body carries the closing keyword, not the commit).

### Task 6: scrub against a fresh clone

The check must not share its source of truth with the fix: the grep list below derives from spec Part 4 ("what the end state must NOT contain"), and it runs against a fresh clone of the branch — what a stranger receives — not the working copy.

- [ ] **Step 1: Push and clone fresh** — `git push -u origin feat/standalone-conveyor`, then clone into the session scratchpad: `git clone --depth 1 --branch feat/standalone-conveyor https://github.com/drakulavich/kesha-voice-kit "$SCRATCH/scrub-clone"`.

- [ ] **Step 2: Scrub** — in the fresh clone:

```bash
grep -rEn "backlog-conveyor|backlog\.ts|gate-evidence|review-prompt\.ts|merge-ready|\bWIP\b|bun run conveyor|just gate|just review" . \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=openspec \
  --exclude-dir=.worktrees --exclude=CHANGELOG.md \
  | grep -v "^\./docs/plans/" | grep -v "^\./docs/superpowers/"
```

Expected: **zero lines**. History dirs (`openspec/changes`, `docs/plans`, `docs/superpowers`, `CHANGELOG.md`) are excluded by name — history stays history. Any other hit is an unfinished deletion: fix it in the worktree, recommit, re-push, re-clone, re-run. Delete the clone when clean.

### Task 7: PR, review with the new tool, gate, merge

- [ ] **Step 1: Open the PR** — `gh pr create` from `feat/standalone-conveyor`, body: `Closes #<N>` (Task 5 Step 2's issue), the spec path, and the scrub command + its empty result as deletion evidence.

- [ ] **Step 2: Review with the tool this PR adopts** — `conveyor review-prompt --pr <P> --claim "the internal conveyor is fully replaced: every deleted surface has a standalone equivalent and no operative text still names the old one" | omc ask grok -p`, backgrounded, log to `.omc/`. Post the `**grok review**` comment (full head SHA, every finding). Confirmed P1/P2 → fix, new head, restart review at the weight the delta earns.

- [ ] **Step 3: Gate** — `evidence_path=$(conveyor evidence grok "<URL of the grok review comment>" --pr <P>)` then `conveyor gate --issue <N> --pr <P> --evidence "$evidence_path" --apply`. Expected: exit 0, and the PR's gate comment shows the **visible line** from Phase A — this is Phase A's acceptance in the wild. Exit 2 listing check-name violations would mean the emoji names didn't survive the trip (spec risk b) — fix the profile spelling, not the tool, if the API shows different names.

- [ ] **Step 4: Human merges.** Then `conveyor close --issue <N> --pr <P> --apply` is **not** used for the worktree here (the migration issue was never a queue line): `just worktree-rm standalone-conveyor` from the root checkout, and `git pull --ff-only` on main.

### Task 8: label cleanup

- [ ] **Step 1:** `gh label delete WIP --yes && gh label delete merge-ready --yes` (verified earlier: nothing carries them). `needs-decision` stays — it is the profile's `blockedLabel`.

### Task 9: seed the queue

- [ ] **Step 1: Draft oldest-first** — write the queue into the conveyor checkout:

```bash
mkdir -p ~/personal/repos/conveyor/state/drakulavich--kesha-voice-kit
gh issue list -R drakulavich/kesha-voice-kit --state open --limit 200 \
  --json number,createdAt --jq 'sort_by(.createdAt) | .[].number' \
  > ~/personal/repos/conveyor/state/drakulavich--kesha-voice-kit/queue.txt
```

- [ ] **Step 2: Maintainer gate** — show the drafted order; the maintainer hand-reorders. The queue is hand-ordered by doctrine; oldest-first is a draft, not a decision. One lane, no lane files.

### Task 10: worktree cleanup

- [ ] **Step 1:** `cd ~/personal/repos/kesha-voice-kit && conveyor sync` (dry-run). Collect the worktree findings (slug-named spikes will read as orphans).
- [ ] **Step 2: Maintainer gate** — present the kill list; the maintainer approves per worktree (a spike dir may hold something unmerged worth keeping).
- [ ] **Step 3:** for each approved slug: `just worktree-rm <slug>` from the root checkout. Re-run `conveyor sync` until it proposes zero actions — the same convergence its ancestor showed (71 → 0).

### Task 11: acceptance — one ticket through the full loop

- [ ] **Step 1:** `conveyor next` — take the selection (issue, agent, branch) at face value; `just worktree <slug> <branch>`; dispatch one fresh-context agent per the runbook; PR; `conveyor review-prompt … | omc ask grok -p`; fix round if findings; `conveyor evidence` + `conveyor gate --apply`; human merges; `conveyor close --apply` (this one **was** a queue line — close strikes it and removes the worktree).
- [ ] **Step 2:** That completed run is the migration's acceptance evidence. Record it in one comment on the Task 5 tracking issue (already closed by the PR): the loop ran end-to-end on the standalone tool.
