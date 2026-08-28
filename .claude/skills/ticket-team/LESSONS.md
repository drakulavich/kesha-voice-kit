# Ledger

One entry per ticket. Appended by the orchestrator from the `retro` agent's report, after
judging it — the retro proposes, it does not write here.

Each defect carries four fields: **what**, **caught at**, **earliest stage that could
have**, and **the change that would move it**. A defect caught at the stage that should
have caught it is a success: one line, no lesson.

Two rules govern what lives here, and both are the bar this repository already applies to a
guard:

- **A rule enters only if it names what it would have caught**, with a ticket as evidence.
  A rule that would not have caught anything is not a lesson, the same way a guard that
  survives its own mutation is not a guard.
- **A rule that has not fired in ten tickets is a candidate for removal**, and is cut for
  being unmeasured rather than for being wrong. A file that only grows stops being read,
  and every rule is paid for by every future agent holding it in context.

`fired` counts tickets where the rule caught something. Update it on every retro, including
when the answer is no.

| rule | added | fired | evidence it was earned |
|---|---|---|---|
| Paths between agents are absolute; nothing depends on a subagent's cwd | #1107 | 1 | The handoff was written in the root checkout and referenced relatively from the worktree — no standard ticket could have reached implementation |
| The OMC skills must be verified registered before the loop starts | #1107 | 1 | The whole protocol named `/omc-plan`, `/execute`, `/omc-review` while the plugin was unregistered; every phase called something that could not resolve |
| Agents deliver by `SendMessage`; idle is availability, not output | #1107 | 1 | Three agents in a row completed their work and reported nothing until asked by name |
| The verdict is a closed shape and the orchestrator fails closed on anything unparseable | #1107 | 0 | Adopted from the conveyor's `findings.ts` before it cost anything here — watch it, and cut it if it never fires |
| Do not manufacture justification for a direction you were given — comply and say "not persuaded", or object before complying | #1105 | 1 | The implementer was directed to narrow a guard, wrote a paragraph justifying the narrowing, and deleted it one round later when the direction reversed. It disclosed this; the rule exists so the disclosure is not what the loop depends on |
| Sign the claim, and name what being wrong would cost and who pays — the ledger names the agent, not only the stage | #1105 | 1 | Four wrong facts reached agents from the orchestrator on one ticket and every one was corrected by an agent that read the file; the same orchestrator reversed one design decision twice and the implementer paid three revisions. None of it would read as a pattern under "caught at plan" |
| A team lead runs the thing it is judging — implement the proposed guard and execute it over every real input, never a sample | #1110 | 2 | Settled both blockers on #1110 (26 errors, then 0 after injection) and #1105 item 3 (a condition parser run over all 14 real `if:` conditions plus two adversarial shapes). #1109's analogous claim stayed an inference and the ledger had to say so |
| Obstacles are stated as what you tried, not as what is impossible | #1105 | 1 | The brief said the run logs could not be retrieved by any route; `gh api --allow-escape-sequences` returns them, and the implementer found it only because it did not take the impossibility on trust |
| A closing keyword is checked for the right word, not for its presence — `Refs #N` when the ticket outlives the change | #1105 | 2 | `Closes #1105` shipped item one of a four-item audit and closed the other three on merge, including the one measured as the most valuable |
| Write the smallest thing that settles the ticket — and treat writing nothing as a real answer | #1105 | 2 | 4 functional lines out of 302; 9 of 9 defects lived in the apparatus around them, which was rewritten four times while the four lines never moved |
| Guard the instance, not the class, until a second instance exists — and treat a guard that changes more often than the thing it guards as the liability signal it is | #1105 | 1 | A rule generalised to unwritten workflows produced all nine defects across three rounds; the guarded file changed in 1 of 5 commits, the guard in 4 of 5 |
| A plan justified by a cost figure must measure the **frequency of the waste**, not the cost of the thing that wastes | #1105 | 1 | The ticket was ranked first on `Rust Tests` being 26.5% of CI cost; the waste it removes is 2.9% of that, while an unranked item in the same audit is worth three years of it per incident |
| The claim handed to a reviewer is quoted from the artifact, never from an agent's summary of it | #1110 | 1 | The implementer's report said "~3-4x headroom"; the PR body said a 5-minute floor plus two scoped exceptions. The orchestrator relayed the summary, and codex refuted a claim that had never shipped |
| After editing a rule, grep the other files for the fact it changed — a fix that states a new rule without retiring the passage that stated the old one | #1107 | 1 | Three findings in one review round, all introduced by earlier fixes: `$WT` survived where the rule had moved to absolute paths, `/simplify` was excused by the precondition meant to catch it, and one file asserted both that the implementer is in the worktree and that it is not, 51 lines apart |
| A second instance of a defect class is the signal to reformulate the guard, not to extend it | #1105 | 1 | Three rounds against one defect — bare literal, `ref_protected`, quoted constant — each closing one spelling. The property-based fix rejected two further spellings on the first try and repaired a false reject neither review had found |
| A plan's mutation list must cover every value AND every input shape the claim rests on, derived from what the end state must not contain | #1105 | 2 | Four findings: a literal `group: github.ref` passed the `includes` check; deleting `cancel-in-progress: true` left everything green; and two of three valid `on:` spellings bypassed the rule entirely |
| The approval carries a digest of the plan it approved | #1107 | 1 | Round 2 on #1105: two readers reported different sizes for the same file — 11250 characters against 11344 bytes — and the digest settled that the content was identical. A size is not an identity |

---

## #1107 — the agent team itself

Five defects, four escaped a stage, four produced a change.

**Handoff written outside the worktree, referenced relatively from inside it.**
Caught at: external review (Greptile). Earliest that could have: plan — the contradiction
was visible in the two files without running anything, since the skill's step 0 created the
worktree while the agent's phase 1 said "no worktree".
Change: paths between agents are absolute, and the protocol no longer depends on any
agent's cwd. Applied at `36289bc`.

**Every OMC invocation unresolvable.**
Caught at: implementation — the implementer reported that `/omc-plan` was never offered to
it, on its own initiative. Earliest that could have: before the loop started; a plugin
present on disk is not a plugin registered, and one glance at the skill listing settles it.
Change: a stated precondition with the check. Applied at `36289bc`.

**Agents complete work and report nothing.**
Caught at: observation, across three agents. Earliest that could have: the same — this is
only visible at runtime, so the stage was right and the cost was three round-trips.
Change: agents `SendMessage` their result; the orchestrator asks explicitly on an idle
signal. Applied at `ce81fa6`.

**Ten further defects in one review** — the trivial lane editing a protected branch, steps
running in the wrong tree, Greptile absent from a loop that CLAUDE.md makes a permanent
gate, an uncapped plan↔approval loop, a `read-only` claim the tools did not enforce.
Caught at: codex review. Earliest that could have: **executing the protocol once**. Every
one was reachable by reading the files against each other; none was found that way.
Change: none to the files — the lesson is that a protocol shipped without a single
execution is prose. Recorded rather than turned into a rule, because "run it once" is not
something an agent file can enforce.

## #1105 — `concurrency` for `rust-test.yml`

Seven defects, five escaped a stage, and the largest of them took three rounds because the guard was written against spellings instead of the property behind them.

**The plan asserted a cancelled run reports `cancelled`; the aggregator reports `failure`.**
Caught at: teamlead, before any code existed. Earliest that could have: the same.
Success — no lesson. Worth the line as evidence the plan round pays for itself: the
verification step built on that claim would have had the implementer report a regression
that was not one. The implementer reproduced the finding itself before rewriting, and found
a third SHA (`e2b9a246`) where the aggregator check is absent entirely.

**Three rounds against one defect: a concurrency group that does not vary per ref.**
Round 1 caught the bare literal `group: github.ref` and was fixed by requiring `${{ … }}`.
Round 2 caught `${{ github.ref_protected }}` and was fixed with a `(?!\w)` boundary. Round 3
caught `${{ 'github.ref' }}` — a quoted constant — as a live P1 on the head that had just
been reviewed clean.
Caught at: codex (round 1), Greptile (rounds 2 and 3). Earliest that could have: **round 2**.
Two different spellings of one failure mode is the signal to ask what property they violate,
not to write a second pattern.

The implementer named this itself when asked, and its formulation is the lesson: at round 1
it wrote a guard against the example in front of it rather than against the property the
example violated, then confirmed each new spelling failed and patched that one — which feels
like evidence-driven work and is three iterations of the same mistake.

Rounds 2 and 3 were avoidable. The eventual fix asserts the property — each `${{ … }}` has
its string literals stripped and must still reference a per-ref context as an operand — and
it rejected two further spellings the implementer invented (`format('github.ref')`, and a
double-quoted form) on the first try, which is the evidence the unit is right rather than
its author's say-so. It also fixed a **false reject** neither review found: the old
`[^}]*` could not cross the `}` inside `{0}`, so a legitimate
`${{ format('{0}', github.ref) }}` was being refused. A pattern wrong in both directions is
not one that needs another clause.

Stated residual, recorded rather than chased: the check is necessary, not sufficient.
`${{ github.ref == 'refs/heads/main' }}` satisfies it and yields two groups repository-wide;
proving injectivity over refs needs an expression evaluator. That boundary is a named test,
not a silence.

**Greptile reported `SUCCESS` at Confidence 4/5 while carrying a live P1 on the head.**
Caught at: orchestrator, by reading the inline findings and checking each `commit_id`
against the head — two P2s in the same listing were stale, pinned to the previous head.
Earliest: the same. Success, no rule: CLAUDE.md already says to gate on findings and never
on the score, and this is the first time in this ledger that rule has paid.

**The orchestrator told the implementer its fix push would supersede the in-flight run "for
free"; all three runs on `b5bf9b7` had already completed.**
Caught at: implementation — the implementer checked before pushing, found nothing in
flight, considered splitting the batch to manufacture the supersession, and rejected that
as the same class of error as writing "reports cancelled" without looking.
Earliest that could have: the orchestrator, with one `gh run list --commit`.
Change: **none proposed.** It cost nothing, and the nearest rule would restate SKILL.md §7's
"verify one decisive thing yourself" rather than add to it.

**`just mutate` invoked with the test command as one quoted string** — spawned the whole
string, ENOENT, exit 2.
Caught at: implementation, immediately, by the implementer. Earliest: the same. Success.
The recipe behaved correctly, so there is nothing to change. Recorded for its near-miss:
reading `$?` through a `| tail` would have shown 0 and read as a pass.

**Not demonstrated live: the cancellation itself.** Not a defect — the plan carried the
standing evidence (two measured cancelled `ci.yml` runs plus the identical `if: always()`
aggregator shape) and the gap is recorded in the pull request body. `none`.


### Outcome

Merged as `12b461c`. The four lines are on `main` and `check:workflows` is green.

One defect escaped every stage of the loop and was caught only after merge: the pull request
carried `Closes #1105`, but #1105 is a four-item audit and this shipped item one. Merging
closed the whole audit, burying the item that the same review had just measured as worth three
years of this one per incident. CLAUDE.md states the rule — `Refs #N` for partial work,
`Closes` only when the ticket is finished.

Caught at: after merge, by the orchestrator. Earliest that could have: **plan**, where the
scope was already known to be one item of four, and again at hand-off, where the orchestrator
verified `Closes #1105` was present in the body and treated its presence as correctness. That
is the failure worth naming: the check ran, passed, and asked the wrong question — whether the
keyword was there, never whether it was the right keyword.

Issue reopened with the three remaining items and the corrected ranking.

### Pareto, measured after the fact

The whole ticket is **4 functional lines out of 302** — the `concurrency` block. The other
295 are the guard around it: 85 lines of lint rule, 210 of tests. All nine defects in this
ticket lived in the guard; the four lines were correct in the first commit and never changed
across three review rounds.

The guard is where the cost went, and the reason is that it was written for a **class** rather
than an instance. `requireConcurrencyOnPullRequestWorkflows` polices workflows nobody has
written yet, so it must handle every way a future author might spell `on:` and every way they
might write a ref expression — which is precisely where all nine defects came from. The
instance assertion, "`rust-test.yml` carries this block", has none of that surface and would
have been about ten lines.

The churn says it plainly. Across five commits the guarded file changed **once**; the rule and
its tests changed **four times each**. CLAUDE.md's own bar is that a test pays off when the
contract is stable and the implementation is likely to change, and is a liability when both
move together. Here the contract never moved and the guard was rewritten every round — the
liability criterion firing in real time, unnoticed while it happened.

This was also infrastructure, not production code. Its failure mode is that CI costs a little
more; nothing a user can observe, no data at risk. That does not make a guard worthless — the
line carrying the whole saving really could be deleted with every test green — but it does set
what the guard is worth paying, and 210 lines of unit test for four lines of CI configuration
is over it.

The ranking was wrong too, and that part is mine: #1105 put this item first on the strength of "`Rust Tests` is 26.5% of CI cost". That is
the cost of *running* the workflow, not the cost of the *waste* the change removes.

Measured afterwards, using `ci.yml` as the proxy — both workflows fire on the same
pull-request events, and `ci.yml` already carries the group so its cancellations are the rate
a working group produces:

| | `rust-test.yml` (no group) | `ci.yml` (has one) |
|---|---|---|
| pull_request runs in 200 | 176 | 136 |
| cancelled | **0 (0%)** | **4 (2.9%)** |

So the saving is ~2.9% of that 26.5%, or roughly three macOS minutes per ten days — about
$0.21 at private-repo rates and exactly $0 here, since the repository is public. Meanwhile
#1105's third item, 26 jobs with no `timeout-minutes` including a macOS build, is worth $22
the first time one hangs for the default 360 minutes: **one incident outweighs three years of
this ticket's saving.**

What the ticket does buy that the money argument misses: a superseded run holds scarce macOS
runners and delays the current one. In a free public repository latency is the real currency.
But the ticket was justified on cost, and on cost the justification does not survive contact
with the frequency.

## The reviewer who cites the run-it rule is the one most obliged to run it

The team lead's own line, offered after it invoked "run the thing you are judging, do not read
it" against the orchestrator's leak-guard diagnosis and then settled the question by reading
the source. Its reading was careful and wrong: `process.ts:63`'s `if (!res.success) return []`
looks like a fail-open branch, but `Bun.spawnSync` *throws* on a pre-exec `posix_spawn` failure,
so that line is unreachable on the EPERM path. It ran the experiment afterwards and confirmed
it — `ENOENT` and `EACCES` both throw, a real `ps` returns `success=true` — then withdrew the
refutation without softening it and asked for the correction to be recorded unsoftened.

Why this is worse than not invoking the rule: **citing it lends the conclusion authority the
method did not earn.** A reviewer that says "I read this and think X" invites a check; one that
says "the rule is to run it, and X" sounds as though it did. The orchestrator's evidence — a
stack frame at `process.ts:62:19`, the `Bun.spawnSync` call itself — was decisive on its own and
should have outweighed a reading of the source, because a value returned from a call cannot
produce a frame at it.

**A fourth instance of the ticket's recurring shape, and this one is the orchestrator's.** It
read a paused review log — 375 KB, not growing, no matching `pgrep` — as a dead process and
relaunched it, having minutes earlier stood the implementer down for running a duplicate. The
first run then completed normally with the findings that were triaged. Its own duplicate was
worse than the one it stopped: same claim, stale head, and a mistaken death certificate.

Snapshot read as state, four times on one ticket: a tree read as unbuilt, a green read as
current, a draft read as never-undrafted, a log read as finished. The fix each time was to get
the timestamp or the process before concluding, not to read more carefully.

## Every agent is `drakulavich` in GitHub's audit trail

On #1105 item 3 the timeline reads `18:31:00Z ready_for_review by drakulavich` then
`18:33:24Z convert_to_draft by drakulavich`. Three agents and one human share that identity,
so **which of them re-drafted the PR cannot be established** — not from the timeline, not from
chat, not at all. No claim is made here about who did it.

The consequence is larger than one event: when two agents report contradictory states, GitHub's
own record cannot arbitrate, and the loop falls back to comparing timestamps in chat. That is
how three separate "contradictions" on this ticket resolved — the digest that had moved, the
green that went stale, and this — every one of them the same artifact: **two true observations
of different moments, read as two claims about one moment.**

**The rule that follows is about reading, not about tooling.** Before recording that two agents
disagree, get both timestamps. A disagreement between agents is a disagreement about *when*
until proven otherwise, and it usually is. Separate GitHub identities per agent would settle
attribution, but that is a change to the maintainer's account, not something this loop adopts
on its own — noted as available, not proposed.

## The review harness degrades the instruction it is graded on

**Open question, deliberately without a number.** Every conveyor review in this repository has
run under `codex exec --sandbox read-only` or `--sandbox workspace-write`. Both break the
prompt's central demand — "where a claim can be settled by running something, run it… do not
settle it by reading" — and neither announces it:

- `read-only`: `just mutate` writes the file under test and restores it in a `finally`. The
  write fails, so "run BOTH mutations, report which assertion fires" is *unsatisfiable*. What
  comes back is reasoning in the shape of verification, which is the one thing the instruction
  exists to prevent.
- `workspace-write`: mutations do run, but `ps` returns EPERM, and `bunfig.toml` preloads
  `tests/helpers/leak-guard.ts` into every suite — so **every** `bun test` reports one spurious
  unnamed failure at `tests/helpers/process.ts:62`. A reviewer either spends a round chasing it
  or reads `144 pass / 1 fail` as a red suite.

  **Mechanism, because a teammate read it the other way and was wrong:** `Bun.spawnSync`
  *throws* when the spawn itself fails, so `process.ts:63`'s `if (!res.success) return []` is
  unreachable on this path and the guard fails **loudly**, not open. Demonstrated rather than
  argued — `Bun.spawnSync(["/nonexistent"])` throws `ENOENT … posix_spawn`, the same class as
  EPERM. The failure is unnamed precisely because it is a thrown exception from the `afterEach`
  hook rather than `report()`'s named message. The `!res.success` branch is real and covers the
  other case: `ps` running and exiting nonzero, which does fail open.
- Both: `ccc` cannot start its daemon (`PermissionError` on `~/.cocoindex_code/daemon.log`), and
  its index lives in the root checkout rather than the worktree. The semantic-search path we
  point reviewers at is simply absent.

**One population is countable, and refusing to count it was the wrong kind of caution.**
`git ls-tree -r --name-only origin/main -- docs/mutation-evidence/` returns exactly one file,
`issue-1093.md`. So *committed* mutation tables before #1111 number **1**, and its rows can be
replayed with `just mutate` in a write-capable environment — a one-command check, not an open
question. Scope it honestly: this bounds committed tables, not mutation claims made in PR
bodies and comments, which is the larger population and remains unknown. Declining to give any
number when a bounded one was one command away is its own failure, and the team lead supplied
it after the orchestrator declared it unknowable.

How many *uncommitted* mutation claims were executed rather than described is **not known**, and
no figure is recorded here because inventing one would be worse than the admission. This is the
loop failing its own standard: it has spent the day asking every agent to name the measurement
behind a claim, while its primary instrument was quietly unable to take one.

**The fix applied now**, pending something better: declare all three artifacts at the top of
the review prompt, state that the mutation instruction is *not* waived because write access
exists, and require that an unrunnable mutation be reported as the command that failed rather
than as a verified row. **The fix not yet applied:** nothing checks that a reviewer ran what it
says it ran. A mutation row is still self-reported.

Found by reading the reviewer's own transcript rather than its conclusion — which is the
practice that found it, and is worth more than the finding.

## #1105 item 3 — `nix-build` (in flight)

**A third divergence, same family, caught before it cost anything.** The team lead told the
implementer the conveyor review was still owed, while the orchestrator had already been
running it for eight minutes. Two finding sets on one head was the outcome avoided. Nobody was
wrong: the protocol assigns review to the orchestrator, and the orchestrator had not said it
had started.

Caught at: the orchestrator, on reading the lead's status message. Earliest that could have:
the orchestrator, at launch. **No new field proposed** — `HEAD`/`STANDING ON` binds verdict
requests and does nothing for a long-running external step. The habit is cheaper than another
header line: **announce a long external step when you start it, not when you report it.**
Recorded here rather than in the protocol precisely because it is a habit; if it recurs, it
earns a rule.

The pattern across all three: a state that exists but is bound to nothing the other party can
read. Twice it was the tree, once it was a running process.

Recorded before the outcome, because the defects are the orchestrator's and "sign the claim"
now applies to it.

**Two wrong inferences from true premises, on the ticket's central design question, both by
the orchestrator and both corrected by the same lead.** First: `security.yml:57` was called the
fact settling class-versus-instance. The premise held — that spelling is in the repo and the
class parser misses it — but the guard is scoped to `ci.yml` and `security.yml`'s jobs are not
in `jobs.ci.needs`, so it is an instance of the *spelling*, not of the defect. Second: "after
commit 2 there are zero push-only jobs, so the class rule guards a non-recurrence." Also true,
also not a reason — the instance guard has zero violators after commit 2 as well, since that
is what turns its test green, so the argument indicts both designs equally; generalised it
forbids every regression test, because every fix removes its own violator.

Caught at: team lead, both. Earliest that could have: the orchestrator, by asking whether the
argument also indicts the option it prefers. **No rule proposed** — "check your argument does
not prove too much" is advice without teeth, and the two rules that already exist carry it:
verify one decisive thing yourself, and sign the claim. Recording the attribution is the
correction.

The argument that actually decides it was in the plan before either of the orchestrator's:
`check:workflows` sits in `preflight`, so a false positive blocks every push until someone
deletes the guard, while a miss costs one red `main`. The class rule carries an over-fire
surface and a blind spot it must document; the instance carries neither.

**The direct loop paid on its first pass.** With the orchestrator out of the exchange, the plan
reached a better argument than the relay had carried — that the *marginal* machinery of a
general rule buys nothing against zero live instances, which is the one-rung-cheaper test
rather than the non-recurrence claim. Reported by the lead, not by the orchestrator.

## #1110 — `timeout-minutes` for the 26 unbounded jobs

Eight defects, four escaped a stage, three produced a change. The plan round paid for itself
twice, and #1109's spelling-chase did not recur.

**Plan r1's guard rejected an already-correct job**, and **its first mutation was a no-op.**
Caught at: teamlead, round 1, both. Earliest: the same. Successes. The team lead settled the
first by *executing* the proposed guard against the real tree — 26 errors, then 0 after
injecting the values — where #1109's analogous claim stayed an inference. The second produced
a live bug nobody was hunting: a bare `timeout-minutes:` parses to `null`, `Number(null)` is
`0`, and such a job would have read as "0 minutes, valid" and passed the guard outright.

**The `uses:` skip branch was unpinned and redundant.** Caught at: codex. Earliest: the same —
§4's full-depth mutation sweep is assigned there. Success. Its second-order note is why it was
removed rather than pinned: the obvious fix would have tested invalid GitHub Actions syntax.

**A claim relayed from a chat summary rather than the artifact.** Caught at: codex. Earliest:
the orchestrator, one `gh pr view --json body` before writing the prompt. Change applied.
Stated honestly: the round was **not** wasted — the same review produced the real `uses:`
finding and sharpened the disclosure from "the guard does not validate the values" to "no
assertion verifies headroom **at all**". Where the over-generalised phrasing originated cannot
be established, because the message it came from is not an artifact anyone can read; the fix
belongs to the orchestrator regardless, since a wrong fact aimed at a **reviewer** costs more
than one aimed at an implementer — the implementer reads the files, the reviewer treats the
claim as the artifact.

**Three wrong OS labels in briefs.** Caught at: plan, by the implementer reading the files.
Earliest: the same. Success, **no rule** — the correction loop is the answer and it cost
nothing measurable.

**Two guards discriminating by the same issue number.** Both file-gate probes filter on
`#1105`, so the new guard's error broke the older probe and forced an out-of-plan edit. Caught
at: implementation, by a red test, and disclosed. Earliest: plan. `no change proposed` — but
items 3 and 4 of the audit are open and the next guard pays the same edit.

**The protocol deletes the artifacts the protocol requires the retro to read.** Caught at:
retro, by luck — the worktree was removed mid-retro, taking the plan and the codex artifact
with it, and `.omc/` is gitignored so the branch carries neither. Earliest: when §8 was
written. §7 ends the ticket at merge with `just worktree-rm`; §8 spawns the retro afterwards
and points it at the worktree. Same class as #1107's top defect: a rule added without checking
the file it contradicts. Change applied — take the durable copy at approval time, which also
closes an approved handoff being edited after its digest was taken, as this one was.

**The ticket shipped without a rate, and the rule against that did not fire.** Caught at:
retro. Earliest: teamlead round 1. The rule asks for the numerator behind a **cost figure**;
this plan led with a measured incident and a duration table, so the question never engaged.
Change applied — it now fires on incident-shaped justifications too.

### Benefit, measured in retro rather than at ranking

999 completed runs, 2026-08-13 → 2026-08-28. Five exceeded 60 minutes of wall clock; four were
queue delay with every job under 4 minutes, which `timeout-minutes` does not bound at all.

**One real stall:** `rust-push-gate` on `ubuntu-latest`, unbounded at its head, held
`Install system audio deps (Opus)` for **360.3 minutes** on 2026-08-18 before GitHub's default
killed it — $2.16 at Linux list, $0.00 billed here.

Both observed instances of this failure mode — that one and #1090's `lint-ubuntu` — are the
same apt step, the same file, on `ubuntu-latest`, on jobs the **narrow** `requireAptTimeouts`
already covered and #1095 had bounded in the commit this branch forked from. **The 24 jobs this
ticket newly bounds have zero observed instances, and the macOS case that ranked the item
first has none either.**

Real failure mode, proven once, bought for ~130 lines of guard and tests against 26 lines of
configuration. Defensible as insurance. The ranking argument was not measured, and three `gh`
queries at plan time would have said so — the second time in two tickets that this audit ranked
on a figure that turned out not to describe the waste.

### Outcome

Merged as `394e013`. CI green on the full head `31dc9d4`; Greptile `SUCCESS` on the same head
with no inline findings, completing two seconds before the merge. `Refs #1105` was the right
keyword — the issue is still open with items 3 and 4.

## #1106 — the npm metadata gate

Two defects, both mine, and the ticket never went through the team.

**Type check run in the root checkout while the new file lived in a worktree.**
Caught at: CI. Earliest that could have: the local gate, had it been run where the change
was.

**Windows failure misdiagnosed as a missing `jq`, then gated on it; the cause was CRLF.**
Caught at: CI, twice, after a wrong fix. Earliest that could have: the local gate — the
repository already documents CRLF checkouts as a recurring class, and the rule is to
reproduce with a real conversion rather than reason about the regex.

Change: none proposed to the team. Neither defect is evidence about the protocol, because
the protocol was not used — I planned nothing, got no verdict, and requested no review.
The honest entry is that working solo cost two wrong diagnoses on one failure, which is an
argument for routing this class of ticket through the team rather than a rule to add to it.
