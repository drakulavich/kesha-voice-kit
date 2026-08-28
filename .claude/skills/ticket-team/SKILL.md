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

`/omc-plan` and `/execute` are the OMC skills this protocol invokes, and a skill present on
disk is not the same as one registered — check your own listing before you start. Step 6's
simplification pass is **not** an OMC skill: `~/.claude/skills/` has no `simplify`. Use the
`code-simplifier` agent, which exists as an agent regardless of what resolves as a command.

If the OMC skills are absent from your listing, `omc setup` installs them and
`omc doctor conflicts` reports the state. This is not hypothetical — the whole protocol was written against them once while the
plugin was unregistered, so every phase named an invocation that could not resolve.

`omc ask` is a **binary**, not a skill, and works regardless.

## 0. One ticket, one worktree — and paths are absolute

Every ticket gets its own worktree, created from the root checkout **before** the implementer
starts, and removed after the hand-off:

```bash
just worktree ticket-<issue> fix/issue-<issue>    # root checkout only; branches off fresh origin/main
# The worktree is <repo>/.worktrees/ticket-<issue>. Write that path out in full every time you
# need it. A shell variable does not survive between Bash calls, and `cd ""` succeeds as a
# no-op — so a command built from a lost variable runs in the root checkout, on main, at exit 0.
…
just worktree-rm ticket-<issue>                   # from the root checkout, never from inside it
```

Two tickets never share a worktree and one ticket never spans two: a ticket's state — its
branch, its uncommitted edits, its failed gate — must be legible on its own and disappear
with it.

**Every path you hand an agent is absolute.** You cannot relocate a subagent's working
directory: the `Agent` tool has no `cwd`, `EnterWorktree` is not in these agents' tool lists,
and a `cd` inside one Bash call does not govern how a Skill or Write resolves a relative path.
So the protocol does not depend on anyone's cwd — it passes `<worktree-abs>` and absolute file paths, and
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
               Your worktree: <worktree-abs>
               Phase 1 only: run /omc-plan --direct, report the plan and the ABSOLUTE path to
               its handoff, then SendMessage it to me and stop.")
```

`--direct` is load-bearing. `/omc-plan` otherwise picks Interview mode for anything broad,
whose first step is `AskUserQuestion` and whose second spawns an `explore` agent — a subagent
has neither, and no user to answer.

**Name agents after the ticket, not the issue.**
One issue can carry several items — #1105 carried four — so `teamlead-<issue>` collides the
moment the second item starts, and a message meant for the new lead reaches the one that
judged the previous item. Use `<issue>-<slug>`: `teamlead-1105-nix`, `impl-1105-timeouts`.

The implementer reports its plan to **you**, never to a team lead directly. You brief the
reviewer, because you are the only party that sees both the plan and what the ticket was
supposed to be — and a verdict issued on a plan you have not read is one you cannot route,
correct, or weigh against the brief you wrote. On #1105 item 3 the implementer addressed its
plan to a lead by name, that lead was the previous item's, and two leads judged the same plan
before anyone noticed.

Spawn the team lead **named too**, and reuse it for every round on this ticket. A fresh one
each round cannot tell whether its own objections were addressed, and may raise a different
set:

```
Agent(name: "teamlead-<issue>", subagent_type: "teamlead",
      prompt: "Ticket: <…>\n\nPlan under review, at <absolute handoff path>: <…>")
```

**The plan loop runs between the implementer and the team lead directly. You are not the
message bus.** Spawn both, name them `<issue>-<slug>`, tell each the other's name, and let the
plan and the verdict pass between them. You are copied on the verdict, not on the traffic.

This is a correction to an earlier rule that said the opposite. That rule was drawn from a
real incident — two leads judging one plan — whose actual cause was a **name collision**,
`teamlead-<issue>` reused across two items of the same issue. Naming per ticket fixed it.
Routing through the orchestrator did not.

What relaying costs, measured on #1105 item 3: every fact that travelled the chain wrong was
the orchestrator's — three mistaken job/OS labels, a headroom figure carried from a chat
summary into a reviewer's prompt, a wrong line number, and an incomplete citation list. The
agents corrected all of them by reading the files. And three of four orchestrator messages in
one stretch argued with a plan one revision stale, because a relay writes against a snapshot
while the author is still revising.

**What stays yours**, none of which needs the traffic to pass through you:

- sizing and scope — what gets built, and what the ticket is not;
- triage of external findings, with the reason recorded for every rejection;
- verifying one decisive thing yourself, per ticket, with one command;
- checking the approval still binds — recompute the digest before the build starts, because
  an approval can be issued against a revision that has since moved;
- the hand-off, and the ledger entry after it.

Step in when the loop stalls, when it exceeds three rounds, or when a verdict and a finding
from elsewhere disagree. Not otherwise.

### The binding block

A verdict binds the artifact it names and **nothing outside it**. Every divergence this loop
has produced so far lived in that gap. Git already closes most of it, so the request opens
with two tokens and nothing else:

```
HEAD:   <git rev-parse HEAD>   <clean | dirty: git status --short>
PLAN:   <absolute path>
DIGEST: <sha256>  <bytes>
STANDING ON: <the HEAD+digest pair whose APPROVED authorises this, or "none — first submission">
```

**`HEAD` is the tree binding, and it is not prose.** At plan time it equals `origin/main`;
the moment a commit lands it does not, and that difference is the whole check. A reviewer
compares two SHAs instead of reading a description of a tree, which is the same reason this
repo gates CI on the full head SHA rather than on `gh pr checks`.

The plan digest survives alongside it only because the plan lives under `.omc/plans/`, which
is ignored — an untracked file is outside what `HEAD` covers. **If the plan is ever committed,
the two collapse into one SHA and the digest line goes.** Do not commit it to the ticket branch
to achieve that: a 26 KB design document in a 51-line diff is noise, and the PR body already
carries the reasoning. A ref outside the branch (`git update-ref refs/plans/ticket-<N>`) is the
version worth trying when a plan is worth keeping.

Each line exists because it was missed:

- **HEAD.** On #1105 item 3 the plan digest reproduced exactly while the guard was already
  written and wired in the worktree. The reviewer had no reason to run `git status`, so the
  early build was invisible to the verdict it was issuing. It happened to be authorised;
  nothing in the protocol made that checkable. One reviewer ran `git log origin/main..HEAD`
  unprompted in two verdicts — putting it in the request turns that habit into a guarantee.
- **STANDING ON.** The same run built against an authorisation embedded inside a
  `CHANGES REQUIRED` ("if you want to start committing, start; what is blocked is the plan
  document as the PR body") rather than against a verdict for the digest in hand. Defensible,
  and disclosed when asked — but naming what you stand on costs one line and removes the
  reconciliation entirely.

**An authorisation inside a rejection is scoped to what it says and expires with the next
verdict.** Quote it when you stand on it. If quoting it makes it look thinner than you
remembered, that is the check working.

**Do not predict a round's cost.** "This is a clause, not a round" was said of a change that
became a round. Say what you are asking for; how much it costs is the other agent's to
report, and a wrong prediction makes the next honest estimate cheaper to dismiss.

Read the verdict's **first line only**, and parse it strictly:

- `VERDICT: APPROVED <digest>` — and the digest must still match `shasum -a 256` of the
  handoff. If it does not, the plan changed after approval: back to the team lead.
- `VERDICT: CHANGES REQUIRED` — or **anything you cannot parse**. Fail closed. A verdict that
  does not match the shape is not an approval.

`CHANGES REQUIRED` goes back to the implementer through `SendMessage`, verbatim. Do not
paraphrase the objections and do not resolve them yourself.

**State obstacles as what you tried, never as what is impossible.** A brief that says "the logs
cannot be retrieved" tells an agent to stop looking; one that says "`gh run view --log` and
`--log-failed` both returned empty for me" tells it where to start. On #1105 item 3 the first
phrasing was wrong — `gh api --allow-escape-sequences` returns the log fine, and the
implementer found it because it did not take the impossibility on trust.

The same applies to facts you relay: if you did not check it yourself this session, say which
of the two it is. An agent that reads files corrects a wrong fact for free; a reviewer that
cannot read them treats it as the artifact.

**Cap the loop at three rounds.** Two is normal. On the third, stop and take the ticket back
to the maintainer: a plan that cannot be approved in three rounds is an unclear ticket, and
the fix belongs in the ticket rather than in the plan.

You may overrule the team lead. If you do, say so in the PR body with the reason.

## 3. Implement

`SendMessage` the approval to the implementer. It runs `/execute` against the **absolute**
handoff path, works in its worktree, lands the failing test first, runs the gate the plan named, and
opens a **draft** PR.

## 4. Review with codex

```bash
cd <repo>/.worktrees/ticket-<issue> && omc ask codex "Review PR #<N>. <the claim the PR makes>.
  Try to refute that claim: name the assertion that would fire if it were false."
```

The `cd` matters: from the root checkout the reviewer reads `main`, which does not contain the
branch. The artifact lands in `<the worktree>/.omc/artifacts/ask/`.

Never assemble a raw `codex` invocation — `omc ask` owns flag selection and artifact capture.
Note its one limitation against this repository's own rule: `omc ask` takes the prompt through
argv, while the conveyor runbook requires prompts by file path because one large diff is
enough to break argv. Keep the claim short for that reason, and if a prompt ever needs to
carry a diff, that is the point to stop using this path.

Quote the claim from the **artifact**, not from an agent's summary of it. On #1110 the
implementer's chat report said the timeout values carried "~3-4x headroom over the slowest
observed sample". The pull request body said something different and correct — a 5-minute
floor for jobs that finish in seconds, ~3x for the two matrix jobs, ~25x for `publish-npm`.
The orchestrator carried the summary's phrasing into the codex prompt, codex correctly
refuted it, and the finding landed on a claim nobody had shipped.

Nothing was lost — the review's other finding was real and the artifacts got tightened
anyway — but the round was spent refuting a sentence that existed only in a chat message.
Read the body, quote the body.

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

## Using git as the team's own substrate

The binding block came from noticing that a hand-rolled digest is a weaker version of
something git already provides. That generalises, and it is worth stating as a principle
rather than rediscovering per-mechanism. Four rules, each with the incident that earned it.
Nothing here is adopted because it is elegant.

**1. Name a SHA, never describe a state.** Anything you would put in prose that git can name —
what the tree looked like, what a reviewer read, what CI actually ran against — gets named by
its SHA instead. *Incident:* two verdict requests quoted a digest the file had already moved
past, and an early build stayed invisible to the verdict being issued because the digest bound
the plan and nothing bound the tree. The repo learned the same lesson one level up: gate CI on
the full head SHA, because after a force-push the PR view reports the superseded run as green.

**2. Every git command names its worktree: `git -C <absolute path>`.** Not `cd` and then git.
*Incident:* a missing `cd` put a commit on `main`, and later wrote a fix into the wrong PR
while `preflight` and CI stayed green on both — the gates were honest about a tree nobody had
asked them about. `cd` is state that survives between calls and that parallel calls race on;
`-C` is an argument, and an argument cannot be left behind by the previous command. This is
strictly stronger than remembering to `cd`, and it costs the same keystrokes.

**3. A coordination artifact that exists only in chat did not happen.** Plans, verdicts,
review output and triage decisions are evidence, and evidence has to be re-readable by an
agent that was not in the conversation. *Incident:* the retro could not establish where a
claim originated, because the only record was a chat message no artifact preserved — and the
honest ledger entry had to say so. Write it to a file in the worktree, or to a ref; a
`SendMessage` body is a notification that evidence exists, not the evidence.

**4. The team's history is not the product's history.** `kesha-voice-kit`'s log is read by
people shipping a voice toolkit; it should not carry which agent approved which digest.
Coordination state goes on the team branch or on refs outside the ticket branch
(`refs/team/<ticket>/…`), never into the product commits or the PR diff. The PR body carries
the reasoning; the trailer-and-verdict machinery stays behind it. This constraint is what
makes rule 3 affordable — durability without noise.

**Considered and not adopted**, so the next agent does not re-propose them: signed commits and
`Approved-by:` trailers on product commits (rule 4 forbids the noise, and no incident calls
for cryptographic identity between cooperating agents); `git notes` for verdicts (attaches to
a commit, and at plan time there are none); and proving reviewer write-containment by diffing
the tree across a verdict (the honour-system version has not been violated once — a guard with
no incident is the liability this ledger keeps retiring).

## Skin in the game

Every claim here is made by someone who can be wrong, and the loop only corrects what it can
attribute. Two rules, and neither is about blame — an unattributed error cannot be seen as a
pattern, and a pattern is the only thing a ledger can act on.

**Sign the claim.** A verdict, a rejected finding, a directive, a relayed fact — each carries
who made it, and the ledger entry for an escaped defect names the stage **and the agent**,
including the orchestrator. On #1105 item 3 the orchestrator supplied three wrong job/OS
labels, a headroom figure lifted from a chat summary, a wrong line number and an incomplete
citation list; every one was corrected by an agent that read the file, and none of it would
have been visible as a pattern if the entries had said only "caught at plan".

**Name the downside and who bears it.** Before directing a change, say what it costs if the
direction is wrong and who pays. A directive whose cost falls entirely on someone else earns
one more look before it is sent. The orchestrator reversed the same design decision twice on
#1105 item 3 — instance, then class, then instance — and the implementer paid three revisions
for it. That was cheap only because the plan round moves prose rather than code, which is the
strongest argument for stopping before implementation anyone made on that ticket; after commit
1 the same churn is rework.

The corollary, which is the part that binds: **the lead that approved a plan reviews the fix
when a defect the plan stage could have caught escapes it.** Not a note in a file — the same
named agent, so the cost of a loose approval returns to the reviewer that gave it rather than
landing on whoever is next.

An agent that cannot say what its own claim would cost if wrong has not finished thinking about
the claim.

### The agency problem

An agent's incentive is to look like it did its job. The principal's interest is that the job
was done. Those diverge quietly, and three of the divergences are live here.

**Do not manufacture justification for a direction you were given.** If you are told to do X
and you think X is wrong, say so before complying. If you comply anyway, write *"complying,
not persuaded"* and leave the reasoning to whoever directed it — do not compose an argument
you do not hold. On #1105 item 3 the implementer was directed to narrow a guard, wrote a
paragraph justifying the narrowing from `security.yml:57`, and deleted that paragraph one
round later when the direction reversed. It disclosed this, which is the behaviour wanted; the
rule exists so it does not depend on the disclosure.

A reviewer has the mirror version: a review with no findings can look like a review that did
not happen, and padding is the cheapest way to look thorough. `No findings` is a result. So is
`this step added nothing to this ticket` — say it when it is true, and say what you would have
had to see for it to be false.

**The orchestrator cannot be the sole scorer of its own errors.** It writes the ledger and its
mistakes are among the entries. The retro reads artifacts, not the orchestrator's account of
them — and where the only record of a claim is a chat message no artifact preserves, the
honest entry says the origin cannot be established rather than assigning it. That has already
happened once, correctly.

**The team is not exempt from the rate question it asks of everyone else.** This loop produces
digests, mutation tables and ledger entries, all of which look like rigour. Whether the
tickets it ships are better than the same tickets shipped without it has never been measured.
Ask it in the retro periodically rather than assuming: what did the loop catch on this ticket
that the gates would have caught anyway, and what did it cost to find out?

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

Spawn `code-simplifier` against the worktree by its full path, and only when the diff got there by accretion. Skip it on a small
clean diff: a simplification pass on three lines is a second review round with nothing to find,
and it invalidates the review that just happened.

## 7. Hand it over

Verify before you claim anything: check CI **by the full head SHA**, not through the pull
request view, which can report a superseded run as green after a force-push. Poll the remote
rather than the working copy — a local snapshot once called an agent stuck while its pull
request was open.

Check the closing keyword for the **right word**, not for its presence. `Closes #N` only when
the change finishes the ticket; `Refs #N` when the ticket outlives it, and then close by hand
once it is genuinely done. Verifying that `Closes` is in the body is not verification — on
#1105 it was there, it was wrong, and merging closed a four-item audit on the strength of one
shipped item.

**Verify one decisive thing yourself**, with one command, rather than relaying what an agent
reported. "Gates green" has been reported here while the type checker had errors, and a green
CI job has existed that never ran the test it was created for.

**Greptile runs on undraft, so do not wait for it inside the loop.** It does not review
drafts: taking the pull request out of draft is what triggers it. Waiting for a report that
cannot exist yet just stalls the hand-off.

So: undraft, assign, report to the maintainer. The review arrives afterwards, and it is
still a merge gate that does not lapse — P1/P2 findings are blockers whenever they land, and
they get the same triage as codex's. Check for it when it arrives rather than blocking on it.

Keep the worktree until the pull request is **merged**, not merely until Greptile has
spoken. A P1 arriving after cleanup needs a tree that no longer exists — and so does the
maintainer's own review, which comes after the hand-off by definition. Optimising the
cleanup around one of the two reviewers and forgetting the other is how a two-line change
turns into recreating a worktree.

```bash
gh pr ready <N>
gh pr edit <N> --add-assignee drakulavich
# report now; Greptile's review lands after undrafting — triage it when it does,
# then: just worktree-rm ticket-<issue>   (from the root checkout)
```

Report in one message: the ticket, what shipped, which findings you applied and which you
rejected with the reason, the gate output, and anything left unverified. State plainly what did
**not** get done.

**Take the durable copy at approval time.** The moment the team lead approves, copy the plan
handoff and — once step 4 runs — the codex artifact out of the worktree into
`.omc/retro/<issue>/` in the **root checkout**. Both live under `.omc/`, which is gitignored,
so the branch carries neither, and §7 removes the worktree at merge. Without the copy the
retro is reading files that a merge can delete underneath it — which has already happened
here: on #1110 the worktree was removed mid-retro and the artifacts survived only because it
had read them minutes earlier.

The copy also closes something nothing else re-checks: an approved handoff can be edited
after its digest was taken, and on #1110 it was — the file's mtime was later than the review
that approved it, and it had been updated to describe work done after the fact. A copy taken
at approval is the version that was actually approved.

## 8. Retro — the ticket is not done until the ledger is

Spawn `retro` once the hand-off is made. It reads the ticket's artifacts — the plan, every
verdict including the `CHANGES REQUIRED` rounds, the codex findings with your triage, the
CI runs, any external review, the final diff — and answers one question per defect: which
stage caught it, and which earlier stage could have.

```
Agent(name: "retro-<issue>", subagent_type: "retro",
      prompt: "Ticket #<issue>, PR #<N>, worktree <worktree-abs>. Artifacts: <plan path>,
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
