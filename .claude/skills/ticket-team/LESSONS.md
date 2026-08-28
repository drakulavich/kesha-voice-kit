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
| A plan's mutation list must cover every value AND every input shape the claim rests on, derived from what the end state must not contain | #1105 | 1 | Four findings: a literal `group: github.ref` passed the `includes` check; deleting `cancel-in-progress: true` left everything green; and two of three valid `on:` spellings bypassed the rule entirely |
| The approval carries a digest of the plan it approved | #1107 | 1 | Round 2 on #1105: the digest matched while the two byte counts did not, which is exactly the case it exists for |

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

Seven defects, five escaped a stage, four produced one shared change.

**The plan asserted a cancelled run reports `cancelled`; the aggregator reports `failure`.**
Caught at: teamlead, before any code existed. Earliest that could have: the same.
Success — no lesson. Worth the line as evidence the plan round pays for itself: the
verification step built on that claim would have had the implementer report a regression
that was not one. The implementer reproduced the finding itself before rewriting, and found
a third SHA (`e2b9a246`) where the aggregator check is absent entirely.

**`group.includes("github.ref")` accepted the bare literal `group: github.ref`** — one
hard-coded repository-wide group, so unrelated pull requests evict each other, which is
worse than no group at all.
Caught at: codex. Earliest that could have: **plan**. The plan required the group to
"interpolate `github.ref`" and then prescribed exactly two mutations, both derived from its
own diff. A mutation list built from the change cannot fail on a wrong-but-accepted value.

**`cancel-in-progress: true` had no guard at all** — deleting it or setting it `false` left
the suite and `check:workflows` green, while that line is the entire cost saving.
Caught at: codex. Earliest that could have: **teamlead**. The plan's Risks section named
the gap in writing and the approval read it as an accepted trade-off. It was not one: the
applied fix scopes `requireRustTestCancelsSupersededRuns` to `rust-test.yml` by `endsWith`,
which never touches `security.yml` and so never needed the investigation the plan named as
its blocker.

**Two of the three valid trigger spellings bypass the rule** — `on: pull_request` and
`on: [pull_request]` are not detected; only the mapping form is. The rule's stated purpose
is to stop a future `pull_request` workflow losing its group, and two ways of writing that
workflow walk past it.
Caught at: Greptile, after undrafting. Earliest that could have: **plan**, by the same
rule as the two above — the end state must not contain an unguarded `pull_request`
workflow *in any spelling*, and the mutation list covered values rather than input shapes.
Notable: the codex sweep ran and did not find this. Both-mutations-per-guard covers the
values a guard reads, not the shapes it must accept.

**`${{ github.ref_protected }}` is accepted, and it is a boolean** — every protected-branch
run collapses into one group, reintroducing the repository-wide failure the literal-`ref`
fix had just closed, spelled differently.
Caught at: Greptile. Earliest that could have: **codex**, whose finding created the
`${{ … }}` requirement; the fix was written against `github.ref` as a substring without
asking which other `github.ref*` values satisfy it.

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
