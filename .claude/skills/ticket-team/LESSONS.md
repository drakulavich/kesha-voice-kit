# Ledger

One entry per ticket. Appended by the team lead from the `retro` agent's report, after
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
| Delivery is by phase — first completion arrives as the return value, after a resume the artifact (handoff digest or PR) is the channel; idle is availability, not output | #1107 | 1 | Superseded the original "deliver by SendMessage" wording, which told agents to use a channel a resumed subagent cannot reach — the failure §0b now documents. Three agents went idle with finished work; a fourth's guessed-name send reached nobody |
| The verdict is a closed shape and the implementer fails closed on anything unparseable | #1107 | 0 | Adopted from the conveyor's `findings.ts` before it cost anything here — watch it, and cut it if it never fires |
| Do not manufacture justification for a direction you were given — comply and say "not persuaded", or object before complying | #1105 | 1 | The implementer was directed to narrow a guard, wrote a paragraph justifying the narrowing, and deleted it one round later when the direction reversed. It disclosed this; the rule exists so the disclosure is not what the loop depends on |
| Sign the claim, and name what being wrong would cost and who pays — the ledger names the agent, not only the stage | #1105 | 2 | Four wrong facts reached agents from the orchestrator on one ticket and every one was corrected by an agent that read the file; the same orchestrator reversed one design decision twice and the implementer paid three revisions. None of it would read as a pattern under "caught at plan" |
| A team lead runs the thing it is judging — implement the proposed guard and execute it over every real input, never a sample | #1110 | 4 | Settled both blockers on #1110 (26 errors, then 0 after injection) and #1105 item 3 (a condition parser run over all 14 real `if:` conditions plus two adversarial shapes). #1109's analogous claim stayed an inference and the ledger had to say so. On #1108 it settled the review's sharpest finding in one command: the lead reproduced the surviving boolean group itself (151 pass, 0 fail, `check:workflows` exit 0) rather than relaying it, and separately ran the suite at both commits in a throwaway clone to confirm the red test was real. It then failed on this ledger's own pull request, which is the sharper lesson: the lead ran its proposed regex over every documented form and read the output of `ugrep`, because `grep` here is a shell function that execs it. Running the tool is not enough when the name resolves to a different tool — say which binary. `fired` does not move for that |
| Obstacles are stated as what you tried, not as what is impossible | #1105 | 1 | The brief said the run logs could not be retrieved by any route; `gh api --allow-escape-sequences` returns them, and the implementer found it only because it did not take the impossibility on trust |
| A closing keyword is checked for the right word, not for its presence, in all **three** independent channels — the pull request body, the pull request **title** (which `COMMIT_OR_PR_TITLE` turns into the squash subject), and the squash commit message — and each issue carries its own keyword. Not a discovery: `CLAUDE.md:95` has said "body or commit message", the `Closes #N, closes #M` rule and the `owner/repo#N` form since `759b08d` (2026-04-20), while the loop's own files carried the body half only | #1105 | 4 | `Closes #1105` shipped item one of a four-item audit and closed the other three on merge, including the one measured as the most valuable. The rule was then followed and failed: #1105 was taken a second time by `27c0995`, the protocol PR, whose body said `Refs #1105` while one of its 74 concatenated messages — `8d3ac7a6`, the commit that added this rule *to the skill* — quoted the keyword twice while narrating the first mis-close. `fired` does not move: the check ran and read the wrong text, and the text that would have told it where else to read had been in `CLAUDE.md` for four months |
| Write the smallest thing that settles the ticket — and treat writing nothing as a real answer | #1105 | 3 | 4 functional lines out of 302; 9 of 9 defects lived in the apparatus around them, which was rewritten four times while the four lines never moved |
| Guard the instance, not the class, until a second instance exists — and treat a guard that changes more often than the thing it guards as the liability signal it is | #1105 | 3 | A rule generalised to unwritten workflows produced all nine defects across three rounds; the guarded file changed in 1 of 5 commits, the guard in 4 of 5 |
| A plan justified by a cost figure or by an incident must measure the **frequency of the waste**, not the cost of the thing that wastes - and must date each cited instance against the rule that now forbids the practice, because run history is evidence about a **regime**, not about a repository. Establish the window over which the governing rule was constant before arguing a rate, and if the instances cluster at one edge of that window, the clustering **is** the finding. And the sharp form: **incidents cluster immediately before the rule that bans them, because the incident is why the rule exists.** So when the evidence sits at one edge, ask not only whether the window was homogeneous but whether the last instance *caused* the boundary. If it did, the evidence is not weak-because-non-stationary, it is inverted - you are citing the case that got the practice prohibited as a sample of ongoing behaviour. Dating it is a walk, not a one-liner: `git log -S '<text>' --reverse -- <file> \| head -1` yields a *candidate*, and the load-bearing step is `git show <sha> -- <file>`, reading whether the diff **adds** the rule or rewords it. If it rewords, take the `-` line as the new search string and repeat. No single command works: `-S` reports any change in the string's count, so newest-first returns a later edit, and `--reverse` still returns that edit when the wording changed - which is the case a reader hits by default, because they can only search text that still exists. Absence of a boundary commit is not evidence of a constant regime either; it means the rule was never written as text, which branch protection, an org setting and a maintainer's habit all satisfy | #1105 | 2 | #1105 ranked first on `Rust Tests` being 26.5% of CI cost while the waste removed is 2.9% of that. #1108 rejected rung 0 on `refs/tags/v1.0.1` carrying three runs at three SHAs - 2026-04-14/15, days 1-2 of a 136-day window - while `6d9e6da` added TAG NAMES ARE ONE-USE to CLAUDE.md on 2026-04-15, the same day as the last instance, and no tag ref has hosted a second run in the ~58 tag releases since. All five repeat-instances sit in the first 1.0% of the window (0.0, 0.0, 0.9, 0.9, 1.0). The operational form is the implementer's, proposed unprompted after the ticket closed; the lead had written only the weaker prose version, which named no check. The inversion is the implementer's, from a fourth pass, and it is the part worth keeping: `6d9e6da` is dated 2026-04-15 15:48:43 UTC, **125 minutes after the last re-push instance started** (run `24458021670`, 13:44:02Z). The cluster runs carry PR titles #90, #91, #92; the commit that ended the regime is #96, "apply lessons learned from v1.0.2 release". The plan's evidence *is* the incident that produced the prohibition. The detection went through three wrong forms first, all the lead's: no ordering flag, then `--reverse`, then `--reverse` again after learning `85a20e7` deleted the heading. Each ran clean and returned `2026-04-15`'s successor `85a20e7 2026-07-26`, at 74% of the window, for a reader searching the wording CLAUDE.md actually contains today - `TAG NAMES ARE ONE-USE` has been absent since that commit reworded it. A detection step that runs clean and returns a confident wrong number is worse than none, which is the objection this ledger raised against the guard #1108 shipped, now made three times against its own rule. The "or by an incident" clause was applied on #1110 and never reached this row, which is why the rule did not engage an incident-shaped justification here either - row 38's class, with this table as the file that kept the old wording |
| The claim handed to a reviewer is quoted from the artifact, never from an agent's summary of it - and a known weakness is conceded by stating the evidence with its dates, never by instructing the reviewer not to report on it | #1110 | 3 | #1110: a relayed summary had codex refute a claim that had never shipped. #1108: the prompt quoted the body verbatim and codex refuted that exact sentence - but it also said "do not report 'no incident evidence' as a finding, it is already conceded", and the review then attacked mechanism only and dated none of the runs the concession rested on |
| After editing a rule, grep the other files for the fact it changed — a fix that states a new rule without retiring the passage that stated the old one. Mechanised at §7: the ledger-write step names `SKILL.md`, `teamlead.md`, `implementer.md` and `retro.md`, and records applied or explicitly declined for each | #1107 | 3 | Three findings in one review round, all introduced by earlier fixes: `$WT` survived where the rule had moved to absolute paths, `/simplify` was excused by the precondition meant to catch it, and one file asserted both that the implementer is in the worktree and that it is not, 51 lines apart. Third fire: `0fe6ab4` retensed three passages describing the untracked era after `27c0995` made them false, and says so in its own message. It has never fired at authoring time — every instance was caught by a second reader afterwards, which is why it is now a step rather than advice |
| A second instance of a defect class is the signal to reformulate the guard, not to extend it | #1105 | 3 | Three rounds against one defect — bare literal, `ref_protected`, quoted constant — each closing one spelling. The property-based fix rejected two further spellings on the first try and repaired a false reject neither review had found |
| A plan's mutation list is keyed per **assertion**, not per guard - for each thing a guard asserts, delete it, and separately leave it present but not satisfying it, plus one control that must survive - and the rule is stated in the planner's file, not only the judge's - and when the guard delegates to an existing predicate, one row per residual that predicate's own doc comment states | #1105 | 3 | Four findings on #1105: a literal `group: github.ref` passed the `includes` check; deleting `cancel-in-progress: true` left everything green; two of three valid `on:` spellings bypassed the rule. #1108 earned the second clause: the plan's wrong-value row chose a constant group the check catches, while the predicate it reused documented the shape it accepts. `fired` does not move for #1108 - the rule did not fire there, it failed. #1105's unit matrix earned both refinements: round 1 caught two live bypasses, then round 2's own 17-shape sweep still had no cell for "matrix row present, macOS, not arm64" and shipped a predicate Greptile filed P2 - a sweep keyed per guard has no visibly empty cell, one keyed per assertion does. And `fd03896` had added "both mutations" to the judge's section ninety minutes earlier, its own message naming that on #1108 "the reviewer was asked for it, the planner was not" - then edited only the judge's file, leaving `implementer.md` asking for "the mutation", singular |
| The approval carries a digest of the plan it approved | #1107 | 2 | Round 2 on #1105: two readers reported different sizes for the same file — 11250 characters against 11344 bytes — and the digest settled that the content was identical. A size is not an identity |
| A check that cannot display the counterexample is not a check - mutate the input so the claim would be false and confirm the check says so. A grep cannot see indirection, so an exclusivity premise is resolved from the executor's side; and a plan cannot commit prose it only described | #1105 | 1 | "`unit-tests` is the only CI job that runs the unit suite" was verified at plan and again at verdict by grepping `.github/workflows/` for `test:unit` - a route that structurally cannot return `coverage:ts` -> `test:cli-fast` -> `tests/unit/` - and it shipped into a committed decision log. The re-derive one-liner was run only against the artifacts that pass, and printed 0 lines at exit 0 on any other junit attribute order - the exact false conclusion the entry it lives in exists to prevent. Converged on independently from the other side: the implementer, unprompted, reported that both of its doc defects came from "verifying my prose by running it once, in the one condition I had". Two agents, four instances, one rule - and it fired on its own author's tooling within the hour, when an anchored replacement refused on `0 occurrences` instead of appending a duplicate entry into a reverted file |

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

## #1105 item 4 — the Homebrew tap's version assertion

PR #1113, shipped from the two-agent loop. Two rules, both proposed by `teamlead-1105-homebrew`
and judged before entering. A third it proposed itself and then retracted, which is recorded
below because the retraction is the useful part.

**Run the tool, not a reimplementation of it.** A scratch reconstruction inherits your
assumptions: `String.replace` takes the first match, `mutate.ts` takes all of them, and a
conclusion drawn from the copy was reported twice as a property of the original. If a claim is
about what a tool does, invoke the tool and paste what it printed.

Caught at: nowhere, until the reviewer re-ran the real recipe while preparing the entry.
Earliest that could have: the moment the claim was first made — `just mutate` prints its own
occurrence count, so one real invocation contradicts the reconstruction immediately.
Fired: 1.

**A shared helper is only as safe as the input shape its existing caller happens to give it.**
`rewriteFormula` inserted a `version` line without stripping one, which was correct for
`stage-homebrew-worktree-formula.mjs` because that caller always starts from the pristine
committed formula. The second caller reads the Homebrew tap's own previous output, so the same
function produced two `version` lines and Homebrew silently kept the stale one. Before reusing a
helper, ask what the new caller's input contains that the old caller's never did.

Caught at: plan verdict, by running the proposed reuse against real Homebrew rather than reading
it. Earliest that could have: the same stage — this is the stage working. No gate could have:
`ci.yml` audits the committed formula before staging, so no lane has ever audited a formula
carrying an injected version.
Fired: 1.

### Retracted before it was filed

The reviewer first proposed a rule that `just mutate` requires a *unique* find-string, believing
the recipe refuses on absence but not on multiplicity and could therefore mutate the wrong
occurrence while still reporting PINNED. Asked to confirm the scope before it was escalated, it
ran the real recipe and withdrew: `scripts/mutate.ts:10-11` is
`source.split(find).join(replace)`, which replaces every occurrence, and line 33 prints the
count. No mutation proof in this repository is weakened and there is nothing to fix.

Kept as an entry because the rule above is exactly what would have prevented it, and because a
ledger that records only the proposals that survived reads as though none are ever wrong. The
question that caught it cost one message.

### Pareto, measured after the fact

+181/-55. The defect fix is ~15 lines: the idempotency strip, the redundant-version omission,
and `versionForTag`. ~45 lines are the refactor that makes the release script importable, ~100
are tests. The refactor also moved the diff inside ci.yml's `homebrew` filter, so
`homebrew-formula` ran a real `brew install` + `brew test` on macOS on the PR itself — reach
bought as a side effect of testability rather than by widening a filter.

What the loop caught that the gates would not have: both blockers. What it cost: three plan
rounds and roughly forty messages, five of which were crossings and three of which were the
orchestrator checking bindings that the participants had already resolved. The orchestrator role
was deleted during this ticket for that reason.

---

## #1108 - `concurrency` for `build-engine.yml`

Sized Light. Two plan rounds, one review round, one consolidation push. Merged as `d738b0b`,
PR #1114, issue closed COMPLETED.

The ticket asked for a *decision*, and both outcomes were legitimate. It shipped a change.

### The ticket's premise was false in both directions

The exposure it named does not exist: two dispatches on `refs/heads/main` cannot leave a
partial draft release, because the `release` job is gated on `startsWith(github.ref,
'refs/tags/v')`. The one such overlap in 96 runs shows `release: skipped` in both.

Its reason for *inaction* was also false: `refs/tags/v1.0.1` hosted three `push` runs at three
distinct head SHAs, so "group size 1 cancels nothing" was wrong. The lead's own measurement
reported that cardinality and then dismissed the runs as sequential retries without pulling
the SHAs; the implementer pulled them. Both halves mattered and neither stage had both.

### Defects

| what | caught at | earliest that could have | the change that would move it |
|---|---|---|---|
| Retry gaps stated as "4.5 and 7.7 min" were one interval in two units; the real start-to-start gaps are 7.62 and 27.90 | plan verdict | plan | none proposed - a slip, caught in one round by re-cutting the author's own data |
| The near-miss argument held the gap fixed while stretching the run, which the retry-follows-failure mechanism forbids | plan verdict | plan | none proposed - the verdict named the mechanism and the plan withdrew the argument rather than repairing it |
| `queue: max` rejected as possibly not a real key | plan verdict | plan | already covered by checking the tool instead of recalling it; the docs settled it in one query |
| The new guard accepted any expression merely mentioning `github.ref` | review | **plan** | the delegated-predicate row above |
| "Cannot change what the tap sees" was false under old-first ordering | review | plan | covered by the run-it row; the mechanism was in `classify-release-tag.mjs` the whole time |
| Rung 0 rejected on evidence that predates the ban on the practice | **retro** | plan | the dated-evidence row above |
| Four-hour stall waiting on a backgrounded review | the session asking | lead | the amended idle row above |
| A post-merge note posted 11 minutes after the merge, framed as input to it | self, on reading the timestamps | lead | none proposed - a recorded practice ("check PR state before any follow-up") existed and was not applied. A rule already stated is a finding about why, not a reason to restate it |

Seven of eight escaped the stage that should have caught them. Two of those were caught by the
review round and one by the retro.

### What the review round bought

It found the unpinned guard, which had already passed the lead's approval and every gate:
1611 tests green, `tsc` clean, `check:workflows` exit 0, four CI workflows green. The lead
reproduced it rather than relaying it, and the implementer then found a second surviving shape
the lead had missed - `${{ github.workflow }}-${{ github.ref }}-${{ github.run_id }}`, which
mentions `github.ref`, passes the predicate, and gives every run its own group. That second
shape is what ruled out the middle fix and forced pinning the exact text.

One of three findings was rejected: the `refs/heads/main` eviction was already disclosed in the
PR body with its window and rate, and the finding read the release-path claim without the
residual that qualified it.

### The judgement the plan never wrote, answered here

The change guards a conjunction whose intersection has never occurred: same-ref concurrency in
2 of 96 runs, a tag ref taking more than one run in 5 runs across 2 refs, never both. That was
disclosed honestly and prominently, which is why it was approvable.

But disclosure is not justification, and the sharper question is what the guard trades. It
removes an unobserved **loud** failure - a draft short a binary, which a user meets as a
`kesha install` 404 - and introduces an unobserved **silent** one: old-first ordering means a
stable or beta release can ship complete and built from a superseded commit, with nothing red
anywhere. For this repository that is the worse direction, and no stage asked the question
before merge. Filed as #1115 with a concrete way to make it loud, rather than reverting four
lines of disclosed config at a 0-in-55 rate.

The honest summary: the change is defensible on cost asymmetry and it stays. Its *justification*
was overstated, and that cleared the lead's approval, not the implementer's plan.

### Rejected, with reasons

- **A rule from the arithmetic slip.** No generalisable trigger; re-cutting the author's own
  data caught it in one round, which is the round the verdict exists for.
- **A rule from the false tap claim.** Already covered by running the thing you are judging and
  by the review's first sweep item.
- **"Pin the group to its exact text."** Derived from the fix. A list built from the change
  cannot fail, which is the same defect as a mutation list derived from the diff.
- **A new rule for the idle stall.** The rule existed; it was scoped to CI waits and the lead
  did not carry it across to a backgrounded process. Amended, not added.
- **Anything of the "be more careful" form.**

### Retirement watch

Nothing reaches the ten-ticket bar; the ledger is seven tickets old. "The verdict is a closed
shape" remains at 0 fires across five tickets and should be cut at ten if it stays silent.

### Addendum: two defects the first draft of this entry missed

This entry was written from the retro's summary and revised when its verbatim proposals
arrived. Both corrections are the lead's, not the retro's.

**The `fired` column was inflated.** The first draft moved row 40 from 2 to 3 and row 41 from
1 to 2. Row 40 did not fire here - it is the rule that failed, and #1108 is what it missed.
The header says `fired` counts tickets where the rule caught something, so incrementing a rule
for the ticket it let through makes the table read as though the guard worked. Reverted to 2,
with the reason stated in the row. Row 41 held rather than caught, and is back to 1. Seven
rows that genuinely fired - 33, 34, 35, 36, 37, 38, 39 - were missed in the same pass and are
now counted.

**The review prompt fenced off the finding that mattered.** The prompt quoted the PR body
verbatim, which is row 37 working, and then added: *do not report "no incident evidence" as a
finding, it is already conceded*. The concession was true. But "the evidence behind the
concession is stale" is a different finding from "there is no evidence", and that sentence
excluded it. Codex attacked mechanism, found the unpinned guard and the false release-path
claim, and dated none of the two runs the concession rested on. The only adversarial reader on
the ticket was told not to go to the one place no other stage looked. Row 37 now carries it.

**One claim in the plan has no confirmed instance and no stage caught it.** Plan v2 lists three
sources of a second run at one tag ref; source 3, "a manual re-dispatch at an existing tag ref",
cites `v1.24.9` and `v1.24.10-alpha.2`. Five of the six dispatch runs at tag refs were created
inside their parent main-lane run's window and are the `tag` job's own self-dispatch, which is
source 2. The sixth cannot be classified from `be-runs.json`. So source 3 may have no instance
at all, and its citations belong to source 2. It never reached the PR body, so its shipped cost
is zero - it cost the exposure argument that decided the ticket. It escaped plan v1, the
verdict, plan v2, the approval, codex and Greptile. Recorded rather than assigned: nobody
established it either way, including this ledger.

---

## #1105 "Worth measuring before acting" — the `unit-tests` macOS row

PR #1116. Heads `d738b0b2` → `13970ec` → `a5c4c8b` → `47b9089` → `c8f5720` → `f5f88c4`. **Nine
defects, six escaped a stage.** The ticket shipped a **decision not to change**: the matrix keeps
three runners because 14 unit cases assert on darwin and nowhere else. Written by
`teamlead-1105-unittests` from the `retro` agent's report, which corrected three of the lead's own
claims in the brief it was given — all three corrections were checked and all three stood.

| what | caught at | earliest that could have | the change that would move it |
|---|---|---|---|
| Plan v1's guard pinned the matrix entry; `exclude:` and a step-level `if:` both left it green | teamlead r1 | plan | the mutation rule in the table above, stated in the planner's file and not only the judge's |
| `Refs #1105` where `Closes` was right, all four waste items having shipped | teamlead r1 | plan | none — the closing-keyword rule working, and the answer was the opposite of #1110's |
| The guard accepted an Intel macOS label; 14 cases go silent with the shape intact | codex | **teamlead r2**, whose own 17-shape sweep had no cell for it | mutations keyed per **assertion**, not per guard |
| "`unit-tests` is the only CI job that runs the unit suite" — false, and it shipped into a committed `docs/decision-log.md` | codex | plan, and again at verdict r1 — the same grep, twice | the counterexample rule in the table above |
| The committed reproduction printed row totals and never derived the 14 | codex | implementation — the plan named "the reproduction command" and never quoted its text | same |
| The entry said the audit "proposed dropping `macos-latest`"; #1105 made it conditional | codex | implementation, same cause | same |
| The **fix** for the reproduction shipped a regex requiring junit attribute order: 0 lines at exit 0 on any other order, i.e. "no darwin assertions" | delta review | the fix push — tested only against the input that passes | same |
| The arm64 predicate is a suffix denylist, so a bare Intel label passes it | **Greptile, P2** | **teamlead**, which observed `macos-13` passing during verification, wrote it off as retired, and left it out of its own triage | see below |
| Round 2 arrived with no binding block; the two verdicts are signed with two different names for one agent | self, in its own artifacts | same | none. The delivery-by-phase rule's artifact-channel wording landed in SKILL.md at 11:10:40Z, *after* the 10:39Z incident. Whether the lead's wrong name correction caused the missing delivery cannot be established — no artifact preserves it. **And the fix has its own residual, named by the implementer after the ticket closed:** reading each head off disk is faster than waiting and made its later sends confirmations rather than triggers, but it fails on the one case nobody checks — a head pushed that the lead never looks for. The lead's mitigation for the rest of the ticket was to block in-call on `git ls-remote` until the branch head moved, rather than end a turn |

### The lead saw the P2 first and dropped it

During verification the lead ran the predicate over 12 real runner labels and logged `true
macos-13`. It reasoned that `macos-13` is retired from `actions/runner-images` — true, and checked —
and therefore omitted it from the triage entirely. The retro then found it as an undeclared
residual, and Greptile filed it P2. **Three parties found it; the lead found it first and recorded
it nowhere.** That is worse than not seeing it, and it is the second time on this ticket the same
lead confirmed a claim by a route that could not have contradicted it.

Fixed on `f5f88c4`: the suffix denylist became a positive allowlist that fails loudly on any
unrecognised macOS label. Verified by mutation through the real recipe — `macos-13` (Greptile's own
example), `macos-15-intel`, `macos-15-large` and `macos-27` (an image that does not exist yet) all
caught; `macos-14`, `macos-26` and `macos-15-xlarge` all survive. Greptile re-reviewed that head
(`Reviews (2)`, last reviewed commit `f5f88c48`) and raised nothing new.

### Benefit: measured on the decision, never measured on the guard

The refused saving is **$0.00 billed, ~$2.7 per ten days notional, and 0 s of latency** —
`windows-latest` is the slower row (65 s median against macOS's 41 s) and gates the same downstream
jobs — against 14 cases that would run in no lane. Both sides carry a number, derived twice
independently. That is better than the two items before it.

The **guard's** rate was never measured at ranking. Measured in retro and re-verified by the lead:
`ci.yml`'s `unit-tests` `os:` list has been touched by **exactly one commit in 145 days** —
`8e16a24`, 2026-04-07, the commit that created it — and no runner has ever been removed from a CI
test matrix in this repository. #1111 looks like a counterexample and is not: `nix-build.yml:57`
still carries `os: [ubuntu-latest, macos-14]`. So the guard is insurance against an event with
**zero instances in the file's entire history**. Defensible — silent coverage loss is the right
thing to insure against — but it is not what "the cheapest 10x saving available" described, and the
frequency rule did not engage because its trigger enumerates cost figures and incidents while this
justification was a *hypothesised future edit*. Third consecutive ticket where that rule's trigger
list, not its idea, is what failed.

### What the loop bought, and what it cost

The gates caught **nothing**: `just preflight` exit 0 on all three pushes (1615 pass / 0 fail),
`tsc` and `check:workflows` clean, three-OS CI green on every head that had one. All nine defects
live in a mutation table, in committed prose, in a fenced code block nothing executes, or in process.

Cost: three CI runs ≈ **19.5 macOS minutes ($1.21 notional)** against a row that burns ~4.7 macOS
minutes a day — **the pull request spent about four days of the cost it was auditing**, on the
audit's own lens — plus two plan rounds, two review rounds and 845 KB of review artifacts.

Bought: three silent failures no gate reaches — the two round-1 bypasses, the Intel label, and the
silent-zero regex. The delta review paid for itself in the one way that is provable: its single
blocker was a defect **introduced by the fix for the previous round's finding**. A fix push is
unreviewed code, and this is the ledger's first datum on what re-reviewing one buys.

**Third consecutive ticket where every defect lived in the apparatus and none in the payload** —
item 1: 9 of 9; #1110: ~130 lines of guard for 26 lines of config; here 9 of 9, with the finding
itself correct in the implementer's first artifact and unchanged across four heads. The
smallest-thing rule and the instance-not-class rule both engaged — rung 0 was weighed explicitly and
§6 refused a class parser by name — and neither prevented it, because both govern size and class,
not the ratio of defects to payload. **Neither is incremented for this ticket**: the retro's own
measurement is that rungs 0-2 would have avoided five of the nine defects, which is the opposite of
the smallest-thing rule having caught something. Three instances is a pattern worth naming and not
yet a rule worth holding.

### Not done, and why

The retro proposed compressing the frequency rule from ~620 words to ~120, moving its #1108 dating
narrative into that ticket's own section. It was deferred, and the reason first given was wrong:
the lead diagnosed a concurrent writer racing its edits on `feat/agent-team`. There was no writer —
`LESSONS.md` was untracked in the root checkout until #1107 merged as `27c0995`, and the merge
checked the tracked file out over it. The deferral stands on its merits and goes to the next
ticket's retro; the mechanism is recorded here because a ledger entry carrying a superseded
diagnosis of its own history is what this ledger exists to prevent.

---

## The audit day — what repeated across #1113, #1114 and #1116

The ledger's shape is one entry per ticket; this is the first cross-ticket one, because these
defects are visible only from above a single ticket. Window `2026-08-28T21:06:53Z` →
`2026-08-29T12:47:01Z`. Measured by `retro-audit-1105`: 12 ticket commits, +363/−55, ~20 functional
lines, against 28 commits on the protocol branch in the same window and ~8h of dead time out of
15h40m. Judged and written by `teamlead-audit-ledger`, which did not author the proposal; four of
the five rows enter, one retirement move is refused, and the refusal rests on a fact the proposal
got wrong.

| what | caught at | earliest that could have | the change that would move it |
|---|---|---|---|
| **A closing keyword quoted as prose inside a commit message closed the audit.** #1105 was taken twice, twenty hours apart. `2026-08-28T16:11:46Z`, `commit_id: null` — #1109, reopened 68 seconds later by the maintainer. Then `2026-08-29T12:32:20Z` against `commit_id 27c0995`: the **protocol** PR #1107, whose body says only `Refs #1105`, whose squash concatenated 74 commit messages, one of which quotes the keyword twice while narrating the first mis-close. That commit, `8d3ac7a6`, is the one that added the closing-keyword rule *to the skill* — `CLAUDE.md:95` had carried the two-channel form since `759b08d`, 2026-04-20, and the skill restated it body-only. #1116, the audit's last item, merged 14m41s later and only "referenced" | nowhere — found at this retro, after the fact | `8d3ac7a6`, where the rule was copied out of `CLAUDE.md` and lost half of itself | Run the check against all three — `gh pr view <N> --json title,body` and `git log <base>..<head> --format=%B` — and keep the keyword out of commit prose. The reason is that they are independent closing mechanisms, not that #1105's two closes were disjoint: #1109 carried the keyword in its body *and* in `b5bf9b7f`, and its body was the live one only because the squash message was trimmed to the title. `squash_merge_commit_message` is `COMMIT_MESSAGES` here, so `git log` predicts the merge box rather than reading it — worth one clause, not the justification. The third channel was found in round 3 and the near-miss is inside this ledger's own evidence: `squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`, #1116's title carried `(#1105)` into `99c8a64`'s subject on `main`, and a keyword there instead of bare parentheses would have taken the audit a third time with the other two checks clean |
| **The per-assertion amendment shipped into two files and not the third.** `fd03896` added "both mutations" to `SKILL.md` alone, leaving `implementer.md` asking the planner for "the mutation", singular. #1117 then rewrote `implementer.md` and the ledger row to per-assertion and left §2's judge paragraph reading "for each guard" — the planner asked for per-assertion rows while the judge held the table to per-guard, the exact inverse of `fd03896`'s defect. #1119 repaired it as `b7da670`, merged `2026-08-29T13:42:44Z` | retro, pre-merge on #1117; by a second reader every previous time | authoring, in both cases | Upgrade the grep-the-other-files rule from advice to a step: the ledger-write step in §7 names `SKILL.md`, `teamlead.md`, `implementer.md` and `retro.md`, and records applied or explicitly declined per file. Four files, not three — `retro.md` is the one `40e75d0` found as the unfixed twin of the same bug |
| **The ledger reaches no agent, and copying a rule out of it is necessary rather than sufficient.** `grep -n LESSONS` across `SKILL.md` and the loop's three agent files returns two hits, both in `SKILL.md`, one resolving the path and one writing the file; no agent is told to read its contents. Mechanically it was also absent from every worktree until `27c0995` (12:32:18Z), after #1113 and #1114 merged. But the proposal's evidence for the stronger claim does not hold: it identified the frequency rule and the grep-the-other-files rule as the only two rows with no counterpart in any instrument file, and the frequency rule has ~90 lines of operational form in `teamlead.md:108-191`, present since `27c0995` and untouched since — the numerator question, the walk-back, the clustering finding, the inversion. It failed on three consecutive tickets **with** that counterpart, on its trigger list. The grep rule is the row where the claim survives: it exists in no instrument file and has never fired at authoring time | retro | when §8 assigned the ledger | `no new rule` — §7's four-file step is the whole remedy, and this row exists to stop it being read as sufficiency. A rule that reached the file it needed and still did not engage is a trigger-list problem, and no amount of placement fixes one |
| **Six commits for one channel class, and the fix for the first caused the third.** `ce81fa6` → `7195368` → `e3d2ef4` → `fbf33ac` → `476995f` → `40e75d0`, the consolidation itself "a two-file fix to a four-file problem" per its reviewer. `ce81fa6` told a subagent to `SendMessage` its result, which a resumed subagent cannot do; `fbf33ac` records the implementer sending to a guessed name that reached nobody while the finished revision sat on disk. A seventh instance then occurred under the amended rules: this retro's completed report went out as the return value `retro.md:114-117` names as its only channel, did not arrive, and the lead had to ask | per incident, each time by a human or an external reviewer | `ce81fa6`, whose own text names no mechanism that could deliver | **Name the runtime mechanism that wakes or reaches the recipient before writing any delivery instruction; if you cannot name one, the instruction is invalid.** In §8, because that is where the loop's own amendments are judged, and it rejects `ce81fa6` on its own text — a subagent told to `SendMessage` its result has no roster to send with, and `fbf33ac` records what that produced. The seventh instance is why it is worded as a test on the author rather than as a seventh delivery instruction — but the next instance is not another sentence's to fix: `retro.md` has no `Write`, so the retro structurally cannot leave the artifact this file's own coordination rule requires, and that is a tool change somebody has to file |
| **Self-correction runs on second readers, not on rules.** Six corrections across the audit: four triggered by another party's question or artifact, one unprompted by a different agent, one whose trigger no artifact preserves. Exactly one traceable to a written rule. Against that, one lead confirmed two claims on one ticket by routes that structurally could not have contradicted them | retro | — | `no change proposed`. The remedy entered the table on #1116 as the counterexample rule; what this adds is scope — it governs **an agent checking its own claim**, not only a guard checking an input |

### Benefit, measured across the audit

Three tickets, ~20 functional lines, **one defect that reaches a user**: item 4's second `version`
line, which would have left the public Homebrew tap publishing a stale version with `brew audit
--strict` exiting 0. Caught at plan verdict by running `brew`, and unreachable by any lane, since
`ci.yml` audits only the committed formula. #1114's benefit is insurance on a conjunction with zero
observed instances, and it shipped a silent failure mode now filed as #1115. #1116's is a measured
decision not to change, plus a guard against an event with zero instances in the file's 145-day
history.

Gates caught nothing on any of the three. Greptile produced one inline finding across all three
pull requests, and the lead had already seen it and dropped it. **On all three of the day's tickets
every defect lived in the apparatus and none in the payload**, which continues the run #1110 and
#1105 item 1 started. The ordinal is not settled: #1116's own entry calls itself the third such
ticket, and counting #1113 and #1114 makes five. Still not a rule — nobody has named what a
defect-to-payload rule would have caught, and a run whose length two entries disagree about is not
the evidence to write one on.

### Refused, with the reason

- **Cutting the frequency rule to ~40 words and moving its operational form to `teamlead.md`.**
  The move is already done — `teamlead.md:108-191` has carried the full form since `27c0995` — and
  the stated ground for the cut, that "it exists in no file any agent loads", is false. What was
  left was a compression of the ledger row for size, which the same proposal argues against on its
  own terms by concluding the ledger is affordable because it is an archive. Refused on the
  evidence, not on the idea: #1116's deferral of the same move stands, and if it returns it needs a
  reason other than reachability.
- **Requiring the retro's proposal to name the target file.** `retro.md:41-42` already requires it —
  "a specific edit to a named agent file or to the protocol". A restatement of something the files
  already say is the first thing `retro.md:61` tells the retro not to propose.
- **A rule from the maintainer interventions, and a rule from the protocol's 28-vs-12 commit rate.**
  Both proposed and both withdrawn by their own author for naming nothing they would have caught.
  Recorded here so neither is re-proposed as new.

### Retirement

| rule | fired | verdict |
|---|---|---|
| The verdict is a closed shape | 0 in 7 tickets | Keep to ten. #1116's round 2 arriving with no binding block was its nearest call and it did not catch it; cutting at seven would be inventing rigour |
| Frequency / rate | 2, failed on 3 consecutive tickets | Keep at full length. The failures are its trigger list, which `teamlead.md` reproduces verbatim — so the next attempt at this row is a trigger-list rewrite, and nobody has drafted one |
| Grep the other files | 2 → **3** (`0fe6ab4`) | Keep and mechanised into §7, with `CLAUDE.md` named as the first file to grep when the rule is the repository's rather than the loop's. Never fired at authoring time — every instance was caught afterwards, and its largest instance is §6's, where the skill carried half of a rule `CLAUDE.md` had stated in full since 2026-04-20 |
| Smallest thing, and instance-not-class | 3 and 2 | Keep, unchanged. Both engaged on #1116 and neither prevented the outcome, because they govern size and class rather than the defect-to-payload ratio |

### Authorship, and what the review round bought

`retro-audit-1105` proposed; the lead judged and wrote. Five things here are the lead's own wording
rather than the retro's: the four-file list in §7 (the proposal said three and omitted `retro.md`),
the both-channels form of the closing-keyword check and its justification, the cross-repo alternative
in §6's regex, the third row above (the proposal's version asserted a correlation the lead
falsified), and the closing sentence of the fourth row.

The lead's first justification for both-channels was wrong and an adversarial review caught it
before the pull request left draft. The lead had written that the proposal's "commit stream instead
of the body" would have missed the 2026-08-28 close; `b5bf9b7f`, #1109's own branch commit, carries
`Closes #1105`, so the commit-stream check would have caught it. The surviving reason is different
and stronger — #1109's squash message was trimmed to the title at merge, so `git log` predicts a
message a human can rewrite — and it is the lead's, written after the refutation. **A seventh instance
for the last row: the correction came from a second reader, on a claim the lead had already
"verified" by running its own command against its own example.** The §6 check then fired on its own
author **three times on this one pull request**, every time in a body sentence explaining the check
itself — twice in the first draft, and once more in the paragraph reporting the regex's own test
inputs. The body is a live channel, so each of those bodies would have acted on merge. That is the
strongest evidence in this entry that the guard works, and it is also the measurement behind the
sentence telling you to keep the keyword out of prose: the rule is not hypothetical, its author
broke it three times while writing it down. Also raised there and not fixed
here, because neither is this pull request's: `check-citations.ts` excludes the skill's own
directory, now noted in §7; and the frequency row says "~58 tag releases since" where
`teamlead.md:168` says "55 non-cli tags… 0/55". That second one is **not** established as drift —
the two phrasings name different denominators and neither reproduces today, since
`git for-each-ref` gives 79 tags after 2026-04-15 of which 54 are non-cli. Recorded because a
reader will take the two figures for one measurement, and left as `27c0995`'s to resolve.

Rounds 2 and 3 then returned four more, all the lead's and all worse than round 1's.
The cross-repo alternative the lead added to §6's regex was `[-\w.]`, which is the literal set
{`-`, `\`, `w`, `.`} in a POSIX bracket expression: under `/usr/bin/grep -inE` it matches no
`owner/repo#N` form at all. It passed because `grep` in this environment is a shell function that
execs `ugrep`, which honours `\w` there — **the lead ran the tool it was judging and still read a
reimplementation of it**, which is row 31's rule failing on the one line that most needed it, and
`fired` does not move for it. And the both-channels fact was never a discovery: `759b08d` added it
to `CLAUDE.md` on 2026-04-20, so what the review round actually bought was the correct diagnosis —
a placement failure, the class of the row two above — in place of the lead's third wrong
justification for the same paragraph. Round 3 then found a **third** closing channel the fix had
still not covered: the pull request title, live because `squash_merge_commit_title` is
`COMMIT_OR_PR_TITLE`. Four rounds, one paragraph, and the lead's own evidence set contained the
near-miss the whole time. Two further halves of `CLAUDE.md:95` had also been dropped on the way in
and are now carried — `gh issue view <N> --json state` after a manual close, and the fact that
auto-close fires only on a merge into the default branch, which `759b08d` added on 2026-04-20 and
`d26b6f5` deleted on 2026-05-18 — `grep -c "default branch" CLAUDE.md` is 0 today and nothing
noticed for three months. The lead's judging is the stage that let all of it
through, and the reviewer is the only reason none of it shipped.
