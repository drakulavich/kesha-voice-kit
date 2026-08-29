---
name: ticket-team
description: Run one ticket from plan to merged pull request with two agents — a team lead that judges and owns the ticket, and an implementer that builds it. Use when handing a ticket to the team rather than doing it yourself.
---

# ticket-team

Two agents run a ticket end to end. **`teamlead` owns it**: sizing, the plan verdict, the review
round, triage, the hand-off and the ledger. **`implementer` builds it**: the plan, the code, the
pull request, the fixes. Nothing else is in the loop.

## The session that invokes this skill

Spawn the team lead, give it the ticket, and get out of the way.

```
Agent(name: "teamlead-<ticket>", subagent_type: "teamlead",
      prompt: "<the ticket, verbatim, plus any coordinates you already have>
               You own this ticket end to end, per the ticket-team skill.
               Report to me once, when the pull request is handed off.")
```

That is the whole of your involvement. You do not size the ticket, spawn the implementer, relay
plans, check digests, triage findings, decide the hand-off, or write the ledger. If you find
yourself composing a message about the ticket's *content*, you have rejoined a loop you were
removed from.

**And you do not run tools on the lead's behalf.** Not `Agent`, not `Write`, not "mechanically,
without judging it". A lead whose configuration does not grant a tool is bounded by that on
purpose, and executing the action for it routes around the boundary while making you the acting
party for a decision you were removed from — the deleted role, re-entering through the service
door. This rule exists because the session that wrote this file offered exactly that during the
handover, unprompted, and the lead refused it on those grounds. If a lead genuinely needs a tool
it lacks, it says so to you and **the maintainer decides** — that is the channel, and it is the
only one.

**Why the role was removed rather than reduced.** An earlier version of this protocol put an
orchestrator above the two agents: it sized, it relayed, it triaged, it handed off. Measured
across #1105, every fact that travelled through it arrived wrong — three mistaken job/OS labels,
a headroom figure lifted from a chat summary into a reviewer's prompt, a wrong line number, an
incomplete citation list — and the agents corrected all of them by reading the files. Its two
substantive interventions on item 4, both binding checks, produced no correction and cost five
messages: it was reading snapshots, and a snapshot held by a party copied on traffic is by
construction older than the participants'. The role's remaining duties were real; none of them
needed a third party to hold.

You will still receive idle notifications from the agents. **An idle signal means "available",
not "here is my output."** Ignore them. The lead reports once, by sending.

Two things stay yours, because they are not ticket work:

- **Stopping the ticket.** If the maintainer wants it abandoned or re-scoped, say so to the lead.
- **Answering a question only the maintainer can answer.** The lead will ask through you when the
  ticket itself is unclear. Relay the maintainer's answer verbatim; do not compose one.

---

Everything below is addressed to the **team lead**.

## Precondition: the OMC skills must resolve

`/omc-plan` and `/execute` are the skills this protocol invokes, and a skill present on disk is
not the same as one registered — check the implementer's listing before you rely on them. The
simplification pass is **not** an OMC skill: `~/.claude/skills/` has no `simplify`. Use the
`code-simplifier` agent, which exists regardless of what resolves as a command.

If the OMC skills are absent, `omc setup` installs them and `omc doctor conflicts` reports the
state. This is not hypothetical — the whole protocol was written against them once while the
plugin was unregistered, so every phase named an invocation that could not resolve.

`omc ask` is a **binary**, not a skill, and works regardless.

## What you own, and the one thing you must not do

You size the ticket, spawn the implementer, judge its plan, authorise the build, run the review
round, triage what comes back, hand the pull request over, and judge the retro's proposed ledger
entry.

**You never author what you judge.** Not the plan, not a revision of it, not the fix for a finding,
not the code. You may say an objection is unaddressed; you may not write the sentence that
addresses it. The moment you draft the remedy, the next verdict you issue is on your own work and
the loop has no reviewer left. This is the single constraint the protocol cannot lose — everything
else here is a refinement of it.

Two consequences worth naming before they bite:

- **You now size the ticket and then judge a plan against your own sizing.** That is a weak form
  of self-approval and it is accepted deliberately: the alternative was a third party whose
  measured contribution was negative. The countermeasure is that the implementer may contest the
  sizing, and a contested sizing goes in the pull request body with both positions.
- **You write the ledger, which is the rulebook you apply.** The `retro` agent proposes and reads
  artifacts you did not write; you judge. Never both propose and accept a rule. A rule you thought
  of yourself goes to the retro to be argued for or dropped.

## 0. One ticket, one worktree — and paths are absolute

Every ticket gets its own worktree, created **before** the implementer starts and removed after the
pull request merges:

```bash
just worktree ticket-<slug> fix/issue-<issue>    # root checkout only; branches off fresh origin/main
…
just worktree-rm ticket-<slug>                   # from the root checkout, never from inside it
```

Two tickets never share a worktree and one ticket never spans two: a ticket's state — its branch,
its uncommitted edits, its failed gate — must be legible on its own and disappear with it.

**Every path you hand an agent is absolute.** You cannot relocate a subagent's working directory:
the `Agent` tool has no `cwd`, and a `cd` inside one Bash call does not govern how a Skill or Write
resolves a relative path later. So the protocol never depends on anyone's cwd — it passes
`<worktree-abs>` and absolute file paths, and every agent reads and writes by them. A relative
`.omc/plans/…` resolves against whichever tree the agent happens to be in, which is how a plan
written in one tree was handed to a step running in another.

**Every git command names its worktree: `git -C <absolute path>`.** Not `cd` and then git. A
missing `cd` once put a commit on `main`, and later wrote a fix into the wrong PR while `preflight`
and CI stayed green on both — the gates were honest about a tree nobody had asked them about. `cd`
is state that survives between calls and that parallel calls race on; `-C` is an argument, and an
argument cannot be left behind by the previous command.

The root checkout stays on `main` throughout — shared coordination state, not an edit surface.

## 0b. Every agent reports by sending, not by finishing

Tell the implementer, in its prompt, to `SendMessage` its result to you when a phase completes. Do
not rely on a final report arriving because an agent stopped: three agents in a row went idle here
having done the work, and delivered nothing until asked for by name. An idle signal means
"available", not "here is my output" — and reading idle as completion means either waiting forever
or proceeding as though a step found nothing to object to.

The mirror of that rule is also true and cost this loop five messages once: **do not read a silence
or a stale artifact as a discrepancy either.** Before asserting that something does not match, ask
what is current. One question is cheaper than three corrections.

**Lead every report with the state it describes**, so the recipient can tell in one line which
snapshot they are holding:

```
HEAD: <git -C <worktree> rev-parse HEAD>   <clean | dirty: git status --short>
```

Messages cross. On #1105 item 4 they crossed six times, and every one resolved the same way: the
newer state belonged to the participant doing the work, and the stale snapshot belonged to whoever
was reviewing or relaying. That is the mechanism that got the orchestrator role deleted, and
reducing the loop to two agents does not remove it — it only halves the traffic. The implementer
started stamping its reports unprompted partway through that ticket and it settled the last three
exchanges in one round each; the rule is `teamlead-1105-homebrew`'s, from the side that kept
receiving the stale half.

A stamped report costs one line and makes a crossing self-resolving on arrival: the reader sees
immediately whether the message predates what they are looking at, instead of discovering it a
round later.

## 1. Size the ticket

Read it first. Sizing decides how much machinery the ticket gets, and over-serving a one-line change
wastes more than under-serving it. Say which you picked and why, in one line, in your first message
to the implementer — it may contest it, and a contested sizing goes in the PR body with both
positions.

- **Trivial** — a constant, a version field, a data sync whose gate already names the right value.
  No plan round, no review round: hand it straight to the implementer as a build instruction.
  **Still in a worktree** — `main` is protected and the root checkout is not an edit surface, so
  there is nowhere else to open a pull request from. CLAUDE.md's test-first exemption covers only
  formatting- and docs-only changes; a constant with a gate behind it is still a change that gate
  must catch.
- **Light** — infrastructure only: workflows, CI scripts, tooling, docs. No product code, no
  `src/**`, no `rust/src/**`. **One** plan message rather than a plan loop, the adversarial review
  on the final head, and the mutation table in the **pull request body** rather than a
  `docs/mutation-evidence/` file. #1105 item 3 was sized Standard and cost seven heads for
  twenty-eight lines of decisions; four of those heads carried no change at all.
- **Standard** — one behaviour in product code, coordinates known or findable in a few searches.
  Full loop.
- **Complex** — crosses the CLI/engine boundary, touches release mechanics, changes synthesized
  audio, or names an outcome rather than a change. Full loop, `implementer` with `model: opus`, and
  expect the plan back at least once.

Sizing is a prediction and it can be wrong in both directions. #1105 item 4 was sized Standard and
earned it: the plan proposed reusing a function that, run twice against its own previous output,
produced a formula Homebrew read stale while `brew audit --strict` exited 0. No existing gate could
have caught that, because CI audits the committed formula before staging. If the ticket is really
several tickets, split it.

## 2. Plan, and judge it

Spawn the implementer **named after the ticket, not the issue**. One issue can carry several items
— #1105 carried four — so `impl-<issue>` collides the moment the second item starts, and a message
meant for the new implementer reaches the one that built the previous item. Use `<issue>-<slug>`:
`impl-1105-nix`, `impl-1105-homebrew`.

```
Agent(name: "impl-<ticket>", subagent_type: "implementer",
      prompt: "<the ticket, verbatim, plus the coordinates you have and which of them you
               verified yourself>
               Your worktree: <worktree-abs>
               I am teamlead-<ticket>; send everything to me.
               Phase 1 only: run /omc-plan --direct, then SendMessage me the plan and the
               ABSOLUTE path to its handoff, and stop.")
```

`--direct` is load-bearing. `/omc-plan` otherwise picks Interview mode for anything broad, whose
first step is `AskUserQuestion` and whose second spawns an `explore` agent — a subagent has neither,
and no user to answer.

**Mark which facts you checked yourself.** An agent that reads files corrects a wrong fact for free;
one that takes it on trust builds on it. State obstacles as what you tried, never as what is
impossible: a brief saying "the logs cannot be retrieved" tells an agent to stop looking, while
"`gh run view --log` and `--log-failed` both returned empty for me" tells it where to start. The
first phrasing was wrong once — `gh api --allow-escape-sequences` returns the log fine, and the
implementer found it because it did not take the impossibility on trust.

You may give the implementer facts. **You may not give it the remedy** — not which file to change,
not the shape of the test, not which of two options you would accept. Facts are free; a design you
supplied is a design you cannot judge.

### The binding block

A verdict binds the artifact it names and **nothing outside it**. Every divergence this loop has
produced lived in that gap. Require the implementer to open every submission with:

```
HEAD:   <git -C <worktree> rev-parse HEAD>   <clean | dirty: git status --short>
PLAN:   <absolute path>
DIGEST: <sha256>  <bytes>
STANDING ON: <the HEAD+digest pair whose APPROVED authorises this, or "none — first submission">
```

**`HEAD` is the tree binding, and it is not prose.** At plan time it equals `origin/main`; the
moment a commit lands it does not, and that difference is the whole check. Compare two SHAs instead
of reading a description of a tree — the same reason this repo gates CI on the full head SHA rather
than on `gh pr checks`. On #1105 item 3 a plan digest reproduced exactly while the guard was already
written and wired in the worktree; nothing in the request made that visible.

**The second token is permanent and not redundant with the first.** `HEAD` says the tree moved; it
does not say which revision of the plan you are approving, and one ticket saw four plan revisions
inside one unchanged tree.

**Hash the file yourself before every verdict.** Never quote the digest from the block — the point
is to check the block, and a digest that was accurate when written goes stale the moment the author
revises. That has already happened: a verdict correctly said "(matched)" and was reading bytes the
implementer replaced minutes later.

**The binding block is the implementer's last action, not its first.** Write the block after the
final edit and send immediately — never compose it, edit further, then send. This rule is
`teamlead-1105-homebrew`'s, proposed after it hit the failure three times in one ticket: a plan
that moves between the block and the send makes the digest wrong on arrival, and the reviewer
then either approves unread bytes or spends a message reconciling. Twice on that ticket the lead
accounted for the delta by hand — `sed`-ing the changed range and checking its byte count against
the file's growth — and approved safely. That worked, and it is not a substitute for sending last.

**Watch for a revision that crosses your verdict.** If the implementer revises in response to
something else while your verdict is in flight, the two pass each other and its revision will not
engage your items. Say so plainly and point at the earlier message rather than restating it — and
do not count the crossing as a round. It is a sequencing artifact, not a failed attempt.

**Do not predict a round's cost.** "This is a clause, not a round" was said of a change that became
a round. Say what you are asking for; how much it costs is the other agent's to report, and a wrong
prediction makes the next honest estimate cheaper to dismiss.

Your verdict's first line is parsed strictly by the implementer:

- `VERDICT: APPROVED <digest>` — the digest of the bytes **you hashed**.
- `VERDICT: CHANGES REQUIRED` — objections stated once, in full, and not rewritten by you.

**Make your objections falsifiable.** Say what run would withdraw each one, and how long it takes.
On #1105 item 4 the lead offered to drop its two blockers against a contradicting run that
reproduced in under a minute — that binds you to a result rather than to a position, and it is the
form to aim for. `No findings` is a result; so is `this step added nothing to this ticket`. Say it
when it is true, and say what you would have had to see for it to be false. A review that pads to
look thorough is the cheapest way to look like a review that happened.

**Say what you credited, not only what you objected to.** A reviewer that only ever reports misses
teaches the author to treat every verdict as hostile.

**Cap the loop at three rounds.** Two is normal. On the third, stop and take the ticket back to the
maintainer through the session that spawned you: a plan that cannot be approved in three rounds is
an unclear ticket, and the fix belongs in the ticket rather than in the plan.

### An authorisation inside a rejection

An authorisation embedded in a `CHANGES REQUIRED` — "if you want to start committing, start; what
is blocked is the plan document as the PR body" — **is scoped to what it says and expires with the
next verdict.** Require the implementer to quote it in `STANDING ON` when it stands on one. If
quoting it makes it look thinner than remembered, that is the check working.

## 3. Implement

Send the approval. The implementer runs `/execute` against the **absolute** handoff path, works in
its worktree, lands the failing test first, runs the gate the plan named, and opens a **draft** pull
request with the closing keyword in the body.

**Recompute the digest before the build starts.** An approval can be issued against a revision that
has since moved.

**Copy the plan out at approval time.** The moment you approve, copy the handoff into
`.omc/retro/<ticket>/` in the root checkout, and the review artifact there too once step 4 runs.
Both live under `.omc/`, which is gitignored, so the branch carries neither, and §6 removes the
worktree at merge. Without the copy the retro reads files a merge can delete underneath it — which
has happened, on #1110. The copy also closes something nothing else re-checks: an approved handoff
can be edited after its digest was taken, and on #1110 it was.

## 4. Review, then triage

**Run the review on the head you expect to be final.** A review aimed at an earlier head reports
everything committed since as missing: on #1105 item 3 the prompt was generated one commit before
the mutation evidence landed, and the review returned that absence as a P2 which cost a round to
explain. The reviewer answered about the head it was given.

```bash
omc ask codex "Review PR #<N>. <the claim the PR makes>.
  Try to refute that claim: name the assertion that would fire if it were false."
```

Run it with the worktree as the working directory — from the root checkout the reviewer reads
`main`, which does not contain the branch. The artifact lands in `<worktree>/.omc/artifacts/ask/`.
Never assemble a raw `codex` invocation; `omc ask` owns flag selection and artifact capture. It
takes the prompt through argv, so keep the claim short — if a prompt ever needs to carry a diff,
that is the point to stop using this path.

**Quote the claim from the pull request body, not from an agent's summary of it.** On #1110 the
implementer's chat report said the timeouts carried "~3-4x headroom over the slowest observed
sample"; the PR body said something different and correct. The summary's phrasing went into the
prompt, codex correctly refuted it, and the finding landed on a claim nobody had shipped.

Ask it to **refute a specific claim**, not to "review the PR" — a claim is required, not a nicety.
Three confident assertions fell to "is that argument correct?" in one day; none fell to "review
this PR". Append the same four sweep items every time, so coverage does not depend on what the
prompt happened to mention:

1. **Guards at full depth** — for every guard the diff adds, run **both** mutations: delete it, and
   separately neutralise it while leaving its shape in place. A guard whose test only catches
   deletion is unpinned against the mutation that actually happens.
2. **Reach** — for every test the diff adds or changes, name the CI lane that executes it, or none.
   A test compiled everywhere and run nowhere has already shipped here.
3. **Second-order** — for each finding, name what fixing it the obvious way would open.
4. **Completeness** — end with what was **not** examined. If that list is empty, say so explicitly:
   an unstated gap reads identically to no gap.

### Triage is yours, not the implementer's

Not every finding gets applied. For each, decide and record:

- **Apply** — a defect, a missing guard, or a contract the diff breaks.
- **Reject** — style, speculation, a rule this repository has deliberately retired (argv-order
  assertions, call counts, "the export exists"), or simply wrong. Say why in one sentence. A
  rejected finding with a reason is a decision; a silently dropped one is a gap, because from the
  outside it is indistinguishable from one that was missed.
- **Defer** — real, but outside this ticket. File it; do not widen the pull request.

Across #753–#800, nine of thirty pull requests carried a reviewer's own P1/P2 findings while that
same reviewer scored them "safe to merge". A reviewer applied wholesale is a reviewer nobody is
reading. If a finding contradicts the approved plan, that is a plan problem — back to §2.

### Propose a remedy this repository can accept

**A finding whose remedy needs two facts in one comment is unsatisfiable here.**
`check-new-comments.ts` rejects any *added* multi-line `#` or `//` run, and replacing a two-line
comment counts as adding one — so "state X and Y in the comment" cannot be applied as written. Name
the one fact that matters and say explicitly that the rest goes in the PR body.

The general form: **a remedy that cannot be executed as specified is discovered only by the person
executing it.** Same shape as a `just mutate` find-string that does not occur. Whoever writes the
remedy owes it a moment's thought about whether the gates will take it, because the cost of skipping
that lands on someone else.

### One consolidation pass — never push prose alone

**Findings are applied in a single push, not one push each.** On #1105 item 3 three of seven commits
changed four lines between them — a false comment, a sharper version of it, and two stale citations
— and each bought a full CI cycle plus a second-reviewer pass. Half the pull request's heads carried
prose.

So: collect every finding from triage, hand them to the implementer as one batch, and have it sweep
the whole diff once before pushing —

```bash
bun .claude/skills/ticket-team/check-citations.ts origin/main HEAD
```

It extracts every `file:line` the diff **adds** and resolves each against the post-diff tree, failing
on a citation that now points at a blank line or cannot be resolved. That is the `ci.yml:984` defect
— accurate on `main`, made false by the very diff containing it, and invisible to codex across two
passes and Greptile across four. A line number is a claim about a file at a revision; nothing else
in the repository checks one.

Then read every comment the diff adds and ask what it **asserts**, not whether it reads well. The
two prose defects on that ticket were both false claims, not clumsy wording.

**A head that changes only prose is a process failure, not a fix.** If one is unavoidable — a
blocking finding after the last push — say so rather than treating it as routine.

## 5. Simplify, if it earns it

Spawn `code-simplifier` against the worktree by its full path, and only when the diff got there by
accretion. Skip it on a small clean diff: a simplification pass on three lines is a second review
round with nothing to find, and it invalidates the review that just happened.

## 6. Hand it over

Verify before you claim anything: check CI **by the full head SHA**, not through the pull request
view, which can report a superseded run as green after a force-push. Poll the remote rather than a
working copy — a local snapshot once called an agent stuck while its pull request was open.

**Watch CI yourself; never go idle waiting for it.** A finishing CI run does not wake you, so
"waiting for the last job" and "stopped forever" are the same state from outside, with nothing to
distinguish them. On #1105 item 4 the lead stood the implementer down pending one job, went idle,
and the ticket sat after that job went green — it took the maintainer asking why the PR was still
in draft to move it. Block on the run instead, in one Bash call:

```bash
gh pr checks <N> --watch --fail-fast     # blocks until every check settles
```

The Bash tool caps a single call at ten minutes, and this repository's heavier lanes can outlast
that. A call that times out is not a failure and not a reason to switch to a poll loop — reissue
the same blocking wait. When it returns, re-verify by the full head SHA anyway: `--watch` follows
the checks it was given, and a push during the wait moves the head underneath it.

Where the harness offers a `Monitor` tool through `ToolSearch`, that works too. `gh` does not
depend on it resolving, which is why it is the one written here.

Check the closing keyword for the **right word**, not for its presence. `Closes #N` only when the
change finishes the ticket; `Refs #N` when the ticket outlives it, and then close by hand once it is
genuinely done. On #1105 `Closes` was there, it was wrong, and merging closed a four-item audit on
the strength of one shipped item.

**Verify one decisive thing yourself**, with one command, rather than relaying what the implementer
reported. "Gates green" has been reported here while the type checker had errors, and a green CI job
has existed that never ran the test it was created for.

**Greptile runs on undraft, so do not wait for it inside the loop.** It does not review drafts;
taking the pull request out of draft is what triggers it. Undrafting is not reversible in the way it
looks — it triggers Greptile and assigns a maintainer who may merge. Treat it as the hand-off it is,
and do not undraft while triage is still open.

```bash
gh pr ready <N>
gh pr edit <N> --add-assignee drakulavich
# report now; Greptile's review lands after undrafting — triage it when it does,
# then once merged: just worktree-rm ticket-<slug>   (from the root checkout)
```

Greptile's findings are a merge gate that does not lapse — P1/P2 are blockers whenever they land,
and they get the same triage as codex's. **Never gate on its Confidence Score**: nine of thirty pull
requests scored "safe to merge" while carrying its own P1/P2 inline findings.

**It edits one comment in place and never posts a second.** So an unchanged comment count is not
evidence it has not re-reviewed, and `created_at` says nothing about which head a comment answers.
Its footer carries `Reviews (N)` and `Last reviewed commit` — that counter is the discriminator.
After a push, wait for `updated_at` to move, not for a count to increment, because it will not.
**Query the login with its `[bot]` suffix**: `select(.user.login=="greptile-apps")` returns empty;
the login is `greptile-apps[bot]`. An empty `jq` result is indistinguishable from "it never
commented" — the same class that made `npm view --json a,b,c` return zero bytes at exit 0, and `ls`
through an `eza` alias return no files and no error. It submits no review state, so `reviews` stays
`[]`; "zero findings" means `pulls/<N>/comments` returned 0.

**Keep the worktree until the pull request is merged**, not merely until Greptile has spoken. A P1
arriving after cleanup needs a tree that no longer exists — and so does the maintainer's own review,
which comes after the hand-off by definition.

Then report **once**, to the session that spawned you: the ticket, what shipped, which findings you
applied and which you rejected with the reason, the gate output, and anything left unverified. State
plainly what did **not** get done.

## 7. Retro, and only if it earns one

You decide whether the ticket gets a retro. Run one when a defect escaped a stage that could have
caught it, when a round was spent on something avoidable, or when the loop did something new. Skip
it when the ticket ran clean, and say in your report that you skipped it and why. A ledger that
grows on every ticket stops being read, and every rule in it is paid for by every future agent that
has to hold it in context.

```
Agent(name: "retro-<ticket>", subagent_type: "retro",
      prompt: "Ticket #<issue>, PR #<N>, worktree <worktree-abs>. Artifacts: <plan path>,
               verdicts, review findings and my triage, CI runs. Propose the ledger entry.")
```

It proposes; **you** judge and write `.claude/skills/ticket-team/LESSONS.md`. Apply the same triage
you applied to the review: a proposed rule enters only if it names what it would have caught, with
this ticket as evidence. Reject the rest **with the reason written down**, including the tempting
ones — a restatement of something the files already say, or advice with no failure attached. If a
rule already existed and was not followed, the finding is about why it was not followed, not that it
should be repeated louder.

Update the `fired` counts, including where the answer is no. Cut what has not fired in ten tickets,
and say in the ledger that it is being cut for being unmeasured rather than for being wrong.

A ticket that produced no lesson gets one line saying so. That is the normal outcome, and inventing
one to look thorough is the failure this step exists to prevent.

Changes to the agent files themselves ship as their own pull request, reviewed like any other. The
ledger is the evidence that PR cites.

## 8. Kaizen — improve the loop while you are inside it

The retro is where improvements are *judged*, not where they are *found*. Findings arrive while
the work is happening, and an improvement noticed mid-ticket costs one message; the same
improvement recovered at retro costs re-reading the whole ticket to reconstruct why it mattered.
So raise it when you hit it, and let §7 decide whether it survives.

Six rules, each with what it is anchored to here. They apply to every agent in the loop, not
only to you.

**Small and continuous beats a rewrite.** This protocol has been restructured twice, and both
times the parts that stuck were single paragraphs attached to a specific incident, while the
large reorganisations mostly restated what the file already said. Prefer the paragraph.

**Standardise before you improve.** You cannot improve a process that is not written down — an
improvement to an unwritten habit is indistinguishable from a preference, and neither can be
argued with. This is the same reason a coordination artifact that exists only in chat did not
happen.

**Go and see.** The strongest rule this loop has produced is "run the tool, not a
reimplementation of it", and it exists because a reviewer twice reported a property of
`scripts/mutate.ts` that it had inferred from a scratch copy using different semantics. When a
claim is about what something does, go to the thing.

**The improvement belongs to whoever hit the friction.** The binding-block rule came from the
lead that hit that failure three times in one ticket; the sharpest framing of the
decision-routing rule came from the implementer, not from the party that wrote it down. Do not
wait to be asked, and do not defer to whoever holds the pen.

**Every proposal carries what it would have caught.** Same bar as the ledger, applied earlier. A
proposal with no failure attached is a preference; say so and drop it rather than filing it as a
rule for someone else to carry.

**Retire at the rate you adopt.** If nothing is being cut, the process is growing, and every line
of growth is paid by every future agent that has to hold it in context. A rule that has not fired
in ten tickets goes, and the ledger says it went for being unmeasured rather than for being
wrong. This section is subject to its own rule.

And keep asking the rate question rather than assuming the answer: what did the loop catch that
the gates would have caught anyway, and what did it cost to find out? Record the unfavourable
answers with the same specificity as the favourable ones. A process that only ever produces
evidence of its own value is not being measured.

## Coordination artifacts, and what git already provides

**1. Name a SHA, never describe a state.** Anything you would put in prose that git can name — what
the tree looked like, what a reviewer read, what CI ran against — gets named by its SHA instead. Two
verdict requests once quoted a digest the file had already moved past, and an early build stayed
invisible to the verdict being issued because the digest bound the plan and nothing bound the tree.

**2. A coordination artifact that exists only in chat did not happen.** Plans, verdicts, review
output and triage decisions are evidence, and evidence has to be re-readable by an agent that was
not in the conversation. A retro once could not establish where a claim originated, because the only
record was a chat message no artifact preserved. Write it to a file under `.omc/retro/<ticket>/`;
a `SendMessage` body is a notification that evidence exists, not the evidence.

**Decisions count as artifacts, and a decision *not* to act is the one that vanishes.** A decision to
act announces itself when the action lands; a decision against a change leaves no trace at all, and
no amount of re-checking surfaces a commit that was never made. So **send a decision against a
proposed change to whoever proposed it** — they are the only party who will notice its absence. On
#1105 item 3 four of five snapshot-as-state instances were the first kind and were caught; the fifth
was the second kind and surfaced only because its author volunteered it.

**3. The team's history is not the product's history.** `kesha-voice-kit`'s log is read by people
shipping a voice toolkit; it should not carry which agent approved which digest. Coordination state
goes under `.omc/` or on refs outside the ticket branch (`refs/team/<ticket>/…`), never into product
commits or the PR diff. The PR body carries the reasoning; the verdict machinery stays behind it.

**Considered and not adopted**, so the next agent does not re-propose them: signed commits and
`Approved-by:` trailers on product commits (rule 3 forbids the noise, and no incident calls for
cryptographic identity between cooperating agents); `git notes` for verdicts (attaches to a commit,
and at plan time there are none); and proving reviewer write-containment by diffing the tree across
a verdict (the honour-system version has not been violated once — a guard with no incident is the
liability this ledger keeps retiring).

## Skin in the game

**Sign the claim.** A verdict, a rejected finding, a directive, a relayed fact — each carries who
made it, and a ledger entry for an escaped defect names the stage **and the agent**, including you.
An unattributed error cannot be seen as a pattern, and a pattern is the only thing a ledger can act
on.

**Name the downside and who bears it.** Before directing a change, say what it costs if the direction
is wrong and who pays. A directive whose cost falls entirely on someone else earns one more look
before it is sent. One reviewer reversed the same design decision twice on #1105 item 3 — instance,
then class, then instance — and the implementer paid three revisions for it. That was cheap only
because the plan round moves prose rather than code, which is the strongest argument anyone made on
that ticket for stopping before implementation; after commit 1 the same churn is rework.

**When two instructions conflict, the receiver names the conflict — it does not pick.** An agent
handed contradictory orders says so to both sources rather than resolving it silently. On #1105 item
3 one message said undraft and another said hold until triage, and the PR was undrafted; which
arrived first cannot be established, because the only record was chat.

**Do not manufacture justification for a direction you were given.** If you think a direction is
wrong, say so before complying. If you comply anyway, write *"complying, not persuaded"* and leave
the reasoning to whoever directed it. On #1105 item 3 the implementer was directed to narrow a guard,
wrote a paragraph justifying it from `security.yml:57`, and deleted that paragraph one round later
when the direction reversed.

**You cannot be the sole scorer of your own errors.** You write the ledger and your mistakes are
among the entries. The `retro` agent reads artifacts, not your account of them — which is why §3
requires the copies. Where the only record of a claim is a chat message no artifact preserved, the
honest entry says the origin cannot be established rather than assigning it.

**The team is not exempt from the rate question it asks of everyone else.** This loop produces
digests, mutation tables and ledger entries, all of which look like rigour. Whether the tickets it
ships are better than the same tickets shipped without it is a measurement, not an assumption. Ask
it in the retro periodically: what did the loop catch that the gates would have caught anyway, and
what did it cost to find out? On #1105 item 4 the answer was favourable and specific — two defects
no lane could have caught, because CI audits the committed formula before staging. Record the
unfavourable answers with the same specificity.
