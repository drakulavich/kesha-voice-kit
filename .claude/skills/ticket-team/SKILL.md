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

## Precondition: the OMC skills must resolve

`/omc-plan`, `/execute` and `/omc-review` are plugin skills, and a plugin that is present on
disk is not the same as one that is registered. Check your own skill listing before you
start; if they are absent, `omc setup` installs them and `omc doctor conflicts` reports the
state. This is not hypothetical — the whole protocol was written against them once while the
plugin was unregistered, so every phase named an invocation that could not resolve.

`omc ask` is a **binary**, not a skill, and works regardless.

## 0. One ticket, one worktree — and paths are absolute

Every ticket gets its own worktree, created from the root checkout **before** the implementer
starts, and removed after the hand-off:

```bash
just worktree ticket-<issue> fix/issue-<issue>    # root checkout only; branches off fresh origin/main
WT="$(pwd)/.worktrees/ticket-<issue>"             # capture it absolute — you will pass this around
…
just worktree-rm ticket-<issue>                   # from the root checkout, never from inside it
```

Two tickets never share a worktree and one ticket never spans two: a ticket's state — its
branch, its uncommitted edits, its failed gate — must be legible on its own and disappear
with it.

**Every path you hand an agent is absolute.** You cannot relocate a subagent's working
directory: the `Agent` tool has no `cwd`, `EnterWorktree` is not in these agents' tool lists,
and a `cd` inside one Bash call does not govern how a Skill or Write resolves a relative path.
So the protocol does not depend on anyone's cwd — it passes `$WT` and absolute file paths, and
every agent reads and writes by them. A relative `.omc/plans/…` resolves against whichever
tree the agent happens to be in, which is how a plan written in one tree was handed to a step
running in another.

The root checkout stays on `main` throughout — shared coordination state, not an edit surface.

## 0b. Every agent reports by sending, not by finishing

Tell each agent, in its prompt, to `SendMessage` its result to you when a phase completes. Do
not rely on a final report arriving because the agent stopped: three agents in a row went idle
here having done the work, and delivered nothing until asked for it by name. An idle signal
means "available", not "here is my output" — and an orchestrator that reads idle as completion
will either wait forever or proceed as though the step found nothing to object to.

## 1. Size the ticket

Read it first. Sizing decides how much machinery the ticket gets, and over-serving a one-line
change wastes more than under-serving it.

- **Trivial** — a constant, a version field, a data sync whose gate already names the right
  value. No plan round, no codex review: you do it yourself. **Still in a worktree** — `main`
  is protected and the root checkout is not an edit surface, so there is nowhere else to open
  a pull request from. Note that CLAUDE.md's test-first exemption covers only formatting- and
  docs-only changes; a constant with a gate behind it is still a change that gate must catch.
- **Standard** — one behaviour, coordinates known or findable in a few searches. Full loop.
- **Complex** — crosses the CLI/engine boundary, touches release mechanics, changes synthesized
  audio, or names an outcome rather than a change. Full loop, `implementer` with `model: opus`,
  and expect the plan back from the team lead at least once.

Say which you picked and why, in one line. If the ticket is really several tickets, split it.

## 2. Plan, and get it approved

Spawn the implementer **named**, and give it the worktree it will work in:

```
Agent(name: "impl-<issue>", subagent_type: "implementer",
      prompt: "<the ticket, verbatim, plus any coordinates you have>
               Your worktree: <absolute $WT>
               Phase 1 only: run /omc-plan --direct, report the plan and the ABSOLUTE path to
               its handoff, then SendMessage it to me and stop.")
```

`--direct` is load-bearing. `/omc-plan` otherwise picks Interview mode for anything broad,
whose first step is `AskUserQuestion` and whose second spawns an `explore` agent — a subagent
has neither, and no user to answer.

Spawn the team lead **named too**, and reuse it for every round on this ticket. A fresh one
each round cannot tell whether its own objections were addressed, and may raise a different
set:

```
Agent(name: "teamlead-<issue>", subagent_type: "teamlead",
      prompt: "Ticket: <…>\n\nPlan under review, at <absolute handoff path>: <…>")
```

Read the verdict's **first line only**, and parse it strictly:

- `VERDICT: APPROVED <digest>` — and the digest must still match `shasum -a 256` of the
  handoff. If it does not, the plan changed after approval: back to the team lead.
- `VERDICT: CHANGES REQUIRED` — or **anything you cannot parse**. Fail closed. A verdict that
  does not match the shape is not an approval.

`CHANGES REQUIRED` goes back to the implementer through `SendMessage`, verbatim. Do not
paraphrase the objections and do not resolve them yourself.

**Cap the loop at three rounds.** Two is normal. On the third, stop and take the ticket back
to the maintainer: a plan that cannot be approved in three rounds is an unclear ticket, and
the fix belongs in the ticket rather than in the plan.

You may overrule the team lead. If you do, say so in the PR body with the reason.

## 3. Implement

`SendMessage` the approval to the implementer. It runs `/execute` against the **absolute**
handoff path, works in `$WT`, lands the failing test first, runs the gate the plan named, and
opens a **draft** PR.

## 4. Review with codex

```bash
cd "$WT" && omc ask codex "Review PR #<N>. <the claim the PR makes>.
  Try to refute that claim: name the assertion that would fire if it were false."
```

The `cd` matters: from the root checkout the reviewer reads `main`, which does not contain the
branch. The artifact lands in `$WT/.omc/artifacts/ask/`.

Never assemble a raw `codex` invocation — `omc ask` owns flag selection and artifact capture.
Note its one limitation against this repository's own rule: `omc ask` takes the prompt through
argv, while the conveyor runbook requires prompts by file path because one large diff is
enough to break argv. Keep the claim short for that reason, and if a prompt ever needs to
carry a diff, that is the point to stop using this path.

Ask it to **refute a specific claim**, not to "review the PR" — a claim is required, not a
nicety. Measured elsewhere: three confident assertions fell to "is that argument correct?" in
one day, none to "review this PR".

Append the same four sweep items every time, so coverage does not depend on what the prompt
happened to mention:

1. **Guards at full depth** — for every guard the diff adds, run **both** mutations: delete
   it, and separately neutralise it while leaving its shape in place. A guard whose test only
   catches deletion is unpinned against the mutation that actually happens.
2. **Reach** — for every test the diff adds or changes, name the CI lane that executes it, or
   none. A test compiled everywhere and run nowhere has already shipped here.
3. **Second-order** — for each finding, name what fixing it the obvious way would open.
4. **Completeness** — end with what was **not** examined. If that list is empty, say so
   explicitly: an unstated gap reads identically to no gap.

## 5. Triage the findings — your job, not the implementer's

Not every finding gets applied. For each, decide and record:

- **Apply** — a defect, a missing guard, or a contract the diff breaks.
- **Reject** — style, speculation, a rule this repository has deliberately retired (argv-order
  assertions, call counts, "the export exists"), or simply wrong. Say why in one sentence. A
  rejected finding with a reason is a decision; a silently dropped one is a gap.
- **Defer** — real, but outside this ticket. File it; do not widen the PR.

Applied findings go back as one batch. If a finding contradicts the approved plan, that is a
plan problem — back to step 2.

## 6. Simplify, if it earns it

Run `/simplify` from `$WT`, and only when the diff got there by accretion. Skip it on a small
clean diff: a simplification pass on three lines is a second review round with nothing to find,
and it invalidates the review that just happened.

## 7. Hand it over

Verify before you claim anything: check CI **by the full head SHA**, not through the pull
request view, which can report a superseded run as green after a force-push. Poll the remote
rather than the working copy — a local snapshot once called an agent stuck while its pull
request was open.

**Verify one decisive thing yourself**, with one command, rather than relaying what an agent
reported. "Gates green" has been reported here while the type checker had errors, and a green
CI job has existed that never ran the test it was created for.

**Greptile is a merge gate and it does not lapse.** Take the PR out of draft first, then wait
for its review: P1/P2 findings are blockers, and this loop must not declare a ticket done
before the gate that outlives it has spoken. Triage its findings the same way as codex's. Keep
`$WT` until then — a P1 arriving after cleanup needs a tree that no longer exists.

```bash
gh pr ready <N>
# wait for Greptile, triage, fix if needed
gh pr edit <N> --add-assignee drakulavich
just worktree-rm ticket-<issue>            # from the root checkout, once the gate has spoken
```

Report in one message: the ticket, what shipped, which findings you applied and which you
rejected with the reason, the gate output, and anything left unverified. State plainly what did
**not** get done.

## 8. Retro — the ticket is not done until the ledger is

Spawn `retro` once the hand-off is made. It reads the ticket's artifacts — the plan, every
verdict including the `CHANGES REQUIRED` rounds, the codex findings with your triage, the
CI runs, any external review, the final diff — and answers one question per defect: which
stage caught it, and which earlier stage could have.

```
Agent(name: "retro-<issue>", subagent_type: "retro",
      prompt: "Ticket #<issue>, PR #<N>, worktree <absolute $WT>. Artifacts: <plan path>,
               verdicts, codex findings and my triage, CI runs. Propose the ledger entry.")
```

It proposes; **you** judge and write `.claude/skills/ticket-team/LESSONS.md`. That split is
the same one the rest of this protocol runs on — nothing approves its own work — and it
matters more here than anywhere, because a retro that edits the team's rules unattended is
a loop with no reviewer at all.

Apply the same triage you applied to codex: a proposed rule enters only if it names what it
would have caught, with this ticket as evidence. Reject the rest **with the reason written
down**, including the tempting ones — a restatement of something the files already say, or
advice with no failure attached. If a rule already existed and was not followed, the finding
is about why it was not followed, not that it should be repeated louder.

Update the `fired` counts, including where the answer is no. Cut what has not fired in ten
tickets, and say in the ledger that it is being cut for being unmeasured rather than for
being wrong.

A ticket that produced no lesson gets one line saying so. That is the normal outcome, and
inventing one to look thorough is the failure this step exists to prevent — a ledger that
only grows stops being read, and every rule in it is paid for by every future agent that
has to hold it in context.

Changes to the agent files themselves ship as their own pull request, reviewed like any
other. The ledger is the evidence that PR cites.
