---
name: ticket-team
description: Run one queued ticket through the agent team — size it, plan it, get the plan approved by the team lead, implement it, review it with codex, triage the findings, and hand the maintainer a ready-for-review pull request. Use when processing tickets from the session queue.
---

# ticket-team

You are the **orchestrator**. You do not write the code and you do not review the plan —
you decide what gets built, judge what comes back, and own the hand-off. Two agents do the
work: `implementer` builds, `teamlead` approves plans.

The queue lives in this session. The maintainer fills it; you take one ticket at a time and
run it to a pull request that is out of draft and assigned to them.

## 0. One ticket, one worktree

Every ticket gets its own worktree, created from the root checkout before the implementer
starts and removed after the hand-off:

```bash
just worktree ticket-<issue> fix/issue-<issue>    # root checkout only; branches off fresh origin/main
…
just worktree-rm ticket-<issue>                   # from the root checkout, never from inside it
```

Create it **before** the implementer starts, not between the plan and the build: the plan
handoff lands in `.omc/plans/` relative to wherever `/omc-plan` ran, `.omc/` is
gitignored, and a plan produced in the root checkout is not there when `/execute` runs
from the worktree. Both phases happen in the same tree.

Name it after the ticket. Two tickets never share a worktree and one ticket never spans
two: the whole point is that a ticket's state — its branch, its uncommitted edits, its
failed gate — is legible on its own and disappears with it. A shared worktree turns a
review comment on one ticket into a diff that also carries another's half-finished work.

The root checkout stays on `main` throughout. It is shared coordination state, not an
edit surface, and `just worktree` refuses to run from anywhere else so cleanup cannot
delete the tree it is standing in. The shell's working directory resets between calls, so
every command inside the worktree `cd`s to it first — a missing `cd` has put commits on
`main` in this repository before.

Remove the worktree once the pull request is out of draft. Leaving it behind is how a
later ticket inherits stale state and a branch nobody is on.

## 1. Size the ticket

Read it first. Sizing decides how much machinery the ticket gets, and over-serving a
one-line change wastes more than under-serving it.

- **Trivial** — a constant, a version field, a typo, a data sync whose gate already names
  the right value. No plan round, no codex review. Do it yourself, open the PR, done. The
  team is overhead here.
- **Standard** — one behaviour, coordinates already known or findable in a few searches.
  The full loop below, `implementer` on its default tier.
- **Complex** — crosses the CLI/engine boundary, touches release mechanics, changes
  synthesized audio, or the ticket names an outcome rather than a change. Full loop,
  `implementer` with `model: opus`, and expect the plan to come back from the team lead at
  least once.

Say which you picked and why, in one line. If the ticket is really several tickets, split
it and run them one at a time rather than handing the implementer a compound brief.

## 2. Plan, and get it approved

Spawn the implementer **named**, so you can continue it rather than re-explaining:

```
Agent(name: "impl-<issue>", subagent_type: "implementer",
      prompt: "<the ticket, verbatim, plus any coordinates you already have>
               Phase 1 only: run /omc-plan, report the plan and its .omc/plans/ path, and stop.")
```

Hand the returned plan to the team lead together with the ticket — it judges the plan
against what was asked, not against its own taste:

```
Agent(subagent_type: "teamlead",
      prompt: "Ticket: <…>\n\nPlan under review:\n<…>")
```

Read the verdict's **first line only**, and parse it strictly:

- `VERDICT: APPROVED <digest>` — and the digest must still match `shasum -a 256` of the
  handoff. If it does not, the plan changed after approval: back to the team lead, not
  forward to the build.
- `VERDICT: CHANGES REQUIRED` — or **anything you cannot parse**. Fail closed. A verdict
  that does not match the shape is not an approval, and treating an unparseable one as
  "nothing to object to" is how unreviewed work ships.

`CHANGES REQUIRED` goes back to the implementer through `SendMessage`, verbatim. Do not
paraphrase the objections and do not resolve them yourself — the implementer revises, the
team lead re-approves. Two rounds is normal; a third means the ticket is unclear, so fix
the ticket rather than the plan.

You may overrule the team lead. If you do, say so in the PR body with the reason — an
overruled objection that goes unrecorded is indistinguishable from one nobody read.

## 3. Implement

`SendMessage` the approval to the implementer. It runs `/execute` against the approved
handoff in `.omc/plans/`, works in a worktree, lands the failing test first, runs the gate
the plan named, and opens a **draft** PR.

## 4. Review with codex

Once the PR exists:

```bash
omc ask codex "Review PR #<N> in this repository. <the claim the PR makes>.
               Try to refute that claim: name the assertion that would fire if it were false."
```

Never assemble a raw `codex` invocation — `omc ask` owns flag selection, provider
compatibility and artifact capture. The artifact lands in `.omc/artifacts/ask/`.

Ask it to **refute a specific claim**, not to "review the PR" — a claim is a required
argument, not a nicety. A reviewer pointed at a claim finds the confident wrong assertion;
a reviewer pointed at a diff finds style. Measured elsewhere: three confident assertions
fell to "is that argument correct?" in one day, none to "review this PR".

Append the same four sweep items every time, so coverage does not depend on what the
prompt happened to mention:

1. **Guards at full depth** — for every guard the diff adds, run **both** mutations:
   delete it, and separately neutralise it while leaving its shape in place. A guard whose
   test only catches deletion is unpinned against the mutation that actually happens.
2. **Reach** — for every test the diff adds or changes, name the CI lane that executes it,
   or none. A test compiled everywhere and run nowhere has already shipped in this
   repository (`model_gate.rs`, `model-suite-guards.test.ts`).
3. **Second-order** — for each finding, name what fixing it the obvious way would open.
4. **Completeness** — end with what was **not** examined. If that list is empty, say so
   explicitly: an unstated gap reads identically to no gap.

## 5. Triage the findings — this is your job, not the implementer's

Not every finding gets applied. For each one decide, and record the decision:

- **Apply** — it is a defect, a missing guard, or a contract the diff breaks.
- **Reject** — it is style, speculation, a rule this repository has deliberately retired
  (argv-order assertions, call counts, "the export exists"), or it is simply wrong. Say
  why, in one sentence. A rejected finding with a reason is a decision; a silently dropped
  one is a gap.
- **Defer** — real, but outside this ticket. File it or note it; do not widen the PR.

Applied findings go back to the implementer through `SendMessage` as one batch, not one at
a time. If a finding contradicts the approved plan, that is a plan problem — back to step 2.

## 6. Simplify, if it earns it

Run `/simplify` only when the diff got there by accretion — a fix round left duplication,
or the shape stopped matching the surrounding code. Skip it on a small, clean diff: a
simplification pass on three lines is a second review round with nothing to find, and it
invalidates the review that just happened.

## 7. Hand it over

Verify before you claim anything: check CI **by the full head SHA**, not through the pull
request view, which can report a superseded run as green after a force-push. Poll the
remote rather than the working copy — a local snapshot once called an agent stuck while its
pull request was open.

And **verify one decisive thing yourself**, with one command, rather than relaying what an
agent reported. "Gates green" has been reported here while the type checker had errors, and
a green CI job has existed that never ran the test it was created for. Today it was the type
check: run in the root checkout, reported clean, while the worktree carrying the new file
did not compile. Pick the check the ticket actually turns on and run it.

Then take the PR out of draft and assign it to the maintainer:

```bash
gh pr ready <N>
gh pr edit <N> --add-assignee drakulavich
```

Report in one message: what the ticket was, what shipped, which codex findings you applied
and which you rejected with the reason, the gate output, and anything left unverified.
State plainly what did **not** get done. A hand-off that hides a skipped step is worse than
one that names it.
