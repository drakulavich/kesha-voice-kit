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
| A closing keyword is checked for the right word, not for its presence — `Refs #N` when the ticket outlives the change | #1105 | 1 | `Closes #1105` shipped item one of a four-item audit and closed the other three on merge, including the one measured as the most valuable |
| Write the smallest thing that settles the ticket — and treat writing nothing as a real answer | #1105 | 1 | 4 functional lines out of 302; 9 of 9 defects lived in the apparatus around them, which was rewritten four times while the four lines never moved |
| Guard the instance, not the class, until a second instance exists — and treat a guard that changes more often than the thing it guards as the liability signal it is | #1105 | 1 | A rule generalised to unwritten workflows produced all nine defects across three rounds; the guarded file changed in 1 of 5 commits, the guard in 4 of 5 |
| A plan justified by a cost figure must measure the **frequency of the waste**, not the cost of the thing that wastes | #1105 | 1 | The ticket was ranked first on `Rust Tests` being 26.5% of CI cost; the waste it removes is 2.9% of that, while an unranked item in the same audit is worth three years of it per incident |
| The claim handed to a reviewer is quoted from the artifact, never from an agent's summary of it | #1110 | 1 | The implementer's report said "~3-4x headroom"; the PR body said a 5-minute floor plus two scoped exceptions. The orchestrator relayed the summary, and codex refuted a claim that had never shipped |
| After editing a rule, grep the other files for the fact it changed — a fix that states a new rule without retiring the passage that stated the old one | #1107 | 1 | Three findings in one review round, all introduced by earlier fixes: `$WT` survived where the rule had moved to absolute paths, `/simplify` was excused by the precondition meant to catch it, and one file asserted both that the implementer is in the worktree and that it is not, 51 lines apart |
| A second instance of a defect class is the signal to reformulate the guard, not to extend it | #1105 | 1 | Three rounds against one defect — bare literal, `ref_protected`, quoted constant — each closing one spelling. The property-based fix rejected two further spellings on the first try and repaired a false reject neither review had found |
| A plan's mutation list must cover every value AND every input shape the claim rests on, derived from what the end state must not contain | #1105 | 1 | Four findings: a literal `group: github.ref` passed the `includes` check; deleting `cancel-in-progress: true` left everything green; and two of three valid `on:` spellings bypassed the rule entirely |
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
