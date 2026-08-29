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

That is the whole of your involvement — no sizing, relaying, digest checks, triage, hand-off
decisions or ledger writes. If you are composing a message about the ticket's *content*, you have
rejoined a loop you were removed from. (The loop used to have an orchestrator in that seat;
measured across #1105, every fact routed through it arrived wrong and its interventions corrected
nothing — a relay reads snapshots, and its snapshot is by construction older than the
participants'.)

**Do not run tools on the lead's behalf** — not `Agent`, not `Write`, not "mechanically, without
judging it". A lead's tool list is a boundary, and executing around it makes you the acting party
for a decision you were removed from; the session that wrote this file offered exactly that,
unprompted, and the lead rightly refused. A lead missing a tool says so, and **the maintainer
decides**.

Idle notifications mean "available", not "here is my output" — ignore them; the lead reports
once. What stays yours: stopping or re-scoping the ticket on the maintainer's word, and relaying
— verbatim, never composing — an answer only the maintainer can give.

---

Everything below is addressed to the **team lead**.

## Precondition: the OMC skills must resolve

`/omc-plan` and `/execute` are the skills this protocol invokes, and a skill present on disk is
not the same as one registered. You cannot see the implementer's listing — it is per-agent,
injected at spawn — so the check is the implementer's own: its charter has it report, in one
line at the top of its plan, whether the skill resolved or it fell back to reading files. The
simplification pass is **not** an OMC skill: `~/.claude/skills/` has no `simplify`. Use the
`code-simplifier` agent, which exists regardless of what resolves as a command.

If the OMC skills are absent, `omc setup` installs them and `omc doctor conflicts` reports the
state. This is not hypothetical — the whole protocol was written against them once while the
plugin was unregistered, so every phase named an invocation that could not resolve.

`omc ask` is a **binary**, not a skill, and works regardless.

**Resolve the team's own three files — `SKILL.md`, `LESSONS.md`, `check-citations.ts` — by full
path, never by the presence of `.claude/skills/`.** They are tracked on `main` as of `27c0995`, so
a worktree branched from current `main` contains them — but one cut from an earlier commit does
not, while `.claude/skills/` itself exists there with ten older siblings, so a directory probe
false-greens exactly where the files are missing. Test the three paths and say which are absent.
§4's sweep runs from the skill's base directory either way: that path is valid in both worlds.

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

## 0b. Which channel carries a result, by phase

An earlier version of this section said "every agent reports by sending" while §2 said "the return
value is the channel". Both were stated unconditionally; each is true for part of the lifecycle,
and the contradiction cost a lead thirty minutes of waiting for a message that could not arrive.
The actual mechanics:

- **First completion** of a spawned subagent arrives as its **return value** — the `Agent` call's
  result. Nothing needs to be sent.
- **After you resume it** by `SendMessage`, there is no second return value. The implementer
  cannot reliably reach you either — it has no roster, and a name it guesses reaches nobody. From
  that point **the artifact on disk is the channel**: re-stat the handoff path, and if the digest
  moved, that is the submission.
- **When the resumed phase produces a pull request rather than a handoff revision, the PR is the
  artifact**: poll `gh pr list --head <branch> --json number,headRefOid` for the build phase, and
  the new head SHA on that PR for a fix batch. The handoff digest never moves in Phase 2, so
  re-statting it reads a finished build as "nothing submitted".
- An **idle notification** is neither. It means "available", not "here is my output" — three
  agents in a row went idle having done the work and delivered nothing until asked by name.

The operational rule that falls out: after any resume, poll the artifact, not the mailbox — and
never end a turn waiting for either.

The mirror also holds and cost five messages once: **do not read a silence or a stale artifact as
a discrepancy.** Before asserting that something does not match, ask what is current. One question
is cheaper than three corrections.

**Lead every report with the state it describes**, so the recipient can tell in one line which
snapshot they are holding:

```
HEAD: <git -C <worktree> rev-parse HEAD>   <clean | dirty: git status --short>
```

Messages cross — six times on one ticket, and every crossing resolved the same way: the newer
state belonged to whoever was doing the work, the stale snapshot to whoever was reviewing. A
stamped report costs one line and makes a crossing self-resolving on arrival; unstamped, it is
discovered a round later.

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
               Phase 1 only: run /omc-plan --direct, end your final message with the plan
               summary and the ABSOLUTE path to its handoff, and stop. After any resume,
               your revised handoff on disk is your submission — do not try to message me.")
```

`--direct` is load-bearing. `/omc-plan` otherwise picks Interview mode for anything broad, whose
first step is `AskUserQuestion` and whose second spawns an `explore` agent — a subagent has neither,
and no user to answer.

The plan reaches you per §0b: first as the `Agent` return value, and after any resume as the file
at the handoff path — re-stat it, and a moved digest is the submission. On the last #1105 item a
finished revision sat on disk for thirty minutes while the lead waited for a message the
implementer had no way to deliver.

**Mark which facts you checked yourself.** An agent that reads files corrects a wrong fact for free;
one that takes it on trust builds on it. State obstacles as what you tried, never as what is
impossible: a brief saying "the logs cannot be retrieved" tells an agent to stop looking, while
"`gh run view --log` and `--log-failed` both returned empty for me" tells it where to start. The
first phrasing was wrong once — `gh api --allow-escape-sequences` returns the log fine, and the
implementer found it because it did not take the impossibility on trust.

You may give the implementer facts. **You may not give it the remedy** — not which file to change,
not the shape of the test, not which of two options you would accept. Facts are free; a design you
supplied is a design you cannot judge.

**At verdict time, hold the plan's mutation table to the review round's first sweep item**: one
row per **assertion**, not per guard — a guard with six assertions has six ways to be neutralised
— with both mutations each, deleted and neutralised-in-shape, plus one row per residual any
delegated predicate names in its own doc comment. Your charter carries the
reasoning; what belongs here is that the check runs at the moment of judging, because on #1108
the reviewer was asked for it, the planner was not, and the guard shipped past an approval with
every gate green.

### The binding block

A verdict binds the artifact it names and **nothing outside it**. Every divergence this loop has
produced lived in that gap. Require the implementer to open every submission with:

```
HEAD:   <git -C <worktree> rev-parse HEAD>   <clean | dirty: git status --short>
PLAN:   <absolute path>
DIGEST: <sha256>  <bytes>
STANDING ON: <the HEAD+digest pair whose APPROVED authorises this, or "none — first submission">
```

**`HEAD` binds the tree, `DIGEST` binds the revision, and neither is redundant** — one ticket saw
four plan revisions inside one unchanged tree, and on another a digest reproduced exactly while
the guard was already built in the worktree. Compare SHAs, never read a description of a tree.

**Hash the file yourself before every verdict** — never quote the digest from the block; the
point is to check the block, and a "(matched)" that was true when written has already gone stale
under a reviewer once.

**The block is the implementer's last action** — composed after the final edit and sent
immediately, or the digest is wrong on arrival (three times in one ticket).

**A revision can cross your verdict in flight.** It then answers something other than your items:
say so, point at the earlier message, and do not count the crossing as a round — it is a
sequencing artifact, not a failed attempt.

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

## 3. Implement

Send the approval. The implementer runs `/execute` against the **absolute** handoff path, works in
its worktree, lands the failing test first, runs the gate the plan named, and opens a **draft** pull
request with the closing keyword in the body.

You learn it finished per §0b's third row: block on `gh pr list --head <branch>` until the PR
exists, then read the PR and the implementer's evidence under `.omc/retro/<ticket>/`. Nothing is
coming by message.

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

**Concede a weakness by stating the evidence and its dates — never by fencing off the topic.**
On #1108 the prompt closed "no incident evidence" as already conceded, which also excluded "the
evidence you rely on is stale" — a different finding, and the one nobody made. A topic you close
is a topic no one can surprise you on.

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

When you write a remedy, check the gates will take it as specified — `check-new-comments.ts`
rejects any added multi-line comment, so "state X and Y in the comment" is unsatisfiable here:
name the one fact that matters and put the rest in the PR body. A remedy that cannot be executed
as written is discovered only by whoever executes it.

### One consolidation pass — never push prose alone

**Findings are applied in a single push, not one push each.** On #1105 item 3 three of seven commits
changed four lines between them — a false comment, a sharper version of it, and two stale citations
— and each bought a full CI cycle plus a second-reviewer pass. Half the pull request's heads carried
prose.

So: collect every finding from triage, hand them to the implementer as one batch, and have it sweep
the whole diff once before pushing —

```bash
bun <this-skill's-base-directory>/check-citations.ts <worktree-abs> origin/main HEAD
```

**The path is the skill's own base directory, not the ticket tree's.** The script is tracked on
`main` as of `27c0995`, but a worktree cut from an earlier commit lacks it while `.claude/skills/`
itself exists there — in the untracked era that made a directory probe false-green and the missing
file read as "not installed" (#1108, where the implementer ran the step and reported the absence
instead of skipping quietly). The base-directory path works in both worlds; a tree-relative one
only in the new.

It takes the worktree as its first argument, runs every git call against that tree, and fails
loudly (exit 2, stderr shown) when git itself fails — an early version inherited the caller's cwd
and returned a green "0 citations" from the root checkout. It skips this skill's own files, whose
ledger quotes historical citations as evidence; a `file:line` quoted as history is a feature
there, not a stale claim. It extracts each added `file:line` for the seven extensions it knows
(`yaml/yml/ts/rs/md/json/nix` — `Cargo.toml`, `justfile` and `.sh` citations pass unchecked) and
resolves it against the post-diff tree, failing
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

**Never end your turn waiting for anything — CI, a backgrounded command, a review, a reply.**
Nothing wakes you, so "waiting" and "stopped forever" are identical from outside. Block in-call
and reissue the wait when the ten-minute Bash cap cuts it short. This has cost two tickets — a
green CI job nobody saw on #1105 item 4, and a finished review that sat unread for four hours on
#1108 because the lead read the rule as CI-only, backgrounded `omc ask`, and confirmed the process
was alive before stopping. **A live process is not a wake-up mechanism**, and there is no category
of wait this excludes.

For CI the blocking form is `gh pr checks <N> --watch --fail-fast`; a timeout is not a failure —
reissue the same wait, and when it returns re-verify by the full head SHA anyway, since a push
during the wait moves the head under the checks being followed.

Check the closing keyword for the **right word**, not for its presence — and in **both** places a
merge closes from. `Closes #N` only when the change finishes the ticket; `Refs #N` when the ticket
outlives it, and then close by hand once it is genuinely done. Each issue needs its own keyword —
`Closes #N, closes #M` — because a bare list closes only the first. On #1105 `Closes` was there, it
was wrong, and merging closed a four-item audit on the strength of one shipped item.

Both-channels is not a discovery. `CLAUDE.md:95` has said "the PR **body or commit message**" since
`759b08d` (2026-04-20) and this file said body-only until now, which is the grep-the-other-files
class with the repository's own charter as the file that was not read. They are independent
mechanisms: a body keyword closes with no commit mentioning the issue, and a squash message closes
with a clean body. #1107 is the second kind — its body said only `Refs #1105`, one of the 74
messages its squash concatenated quoted the keyword twice while narrating an earlier mis-close, and
the timeline records the close against `commit_id 27c0995`. `squash_merge_commit_message` is
`COMMIT_MESSAGES` here and the merge box is then editable — #1109's was trimmed to its title — so
`git log` *predicts* that message rather than reading it. Read the box before confirming a squash.

```bash
KW='\b(close[sd]?|fix(es|ed)?|resolve[sd]?)[ :]*([[:alnum:]._-]+/[[:alnum:]._-]+)?#[0-9]+'
gh pr view <N> --json body -q .body    | grep -inE "$KW"
git log <base>..<head> --format=%B     | grep -inE "$KW"
```

Both must return only the keywords you meant. **Verify a shell snippet under `/usr/bin/grep`, not
under `grep`**: this environment shadows it with a function that execs `ugrep`, which honours `\w`
inside a bracket expression where POSIX ERE takes the backslash literally — the first version of
this line shipped as `[-\w.]`, was verified green, and matched no `owner/repo#N` form under the
real binary. Keep the keyword out of commit prose: name the issue without one when narrating, or
the sentence describing a mis-close performs another.

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

It proposes; **you** judge and write the ledger — `LESSONS.md` beside this skill's own SKILL.md,
by the absolute path this skill's base directory gives you, never the relative name. The live
hazard: the ledger is tracked now, so the relative name resolves to the **ticket worktree's**
copy, and a `Write` there lands the ledger change inside the ticket's own diff — an agent-file
change smuggled past its own separate-PR rule, invisible to the gates. (In the untracked era the
same relative name failed the opposite way, creating a fresh empty ledger on `main`.) Apply the
same triage
you applied to the review: a proposed rule enters only if it names what it would have caught, with
this ticket as evidence. Reject the rest **with the reason written down**, including the tempting
ones — a restatement of something the files already say, or advice with no failure attached. If a
rule already existed and was not followed, the finding is about why it was not followed, not that it
should be repeated louder.

Update the `fired` counts, including where the answer is no. Cut what has not fired in ten tickets,
and say in the ledger that it is being cut for being unmeasured rather than for being wrong.

**The ledger write is not the change.** A rule takes effect when it is copied into `SKILL.md`,
`teamlead.md`, `implementer.md` or `retro.md` — what an agent actually holds in context — and the
ledger is the archive of why. So name all four at the write step and record, per file, applied or
explicitly declined. `fd03896` added "both mutations" to this file and edited nothing else, leaving
`implementer.md` asking the planner for "the mutation", singular; #1117 then shipped the
per-assertion wording into two files and left §2's judge paragraph on the old one, which `b7da670`
repaired. Placement is necessary and it is not sufficient — the frequency rule has its full
operational form in `teamlead.md` and failed on three consecutive tickets anyway, on its trigger
list rather than its location.

And when the rule is about how this repository works rather than about this loop, `CLAUDE.md` is
the first file to grep, not the fifth: §6's closing-keyword rule was copied out of `CLAUDE.md:95`
into the skill body-only and cost a review round four months later rediscovering the other half.

`check-citations.ts` will not help here: it excludes `.claude/skills/ticket-team/*` from the diff it
scans, so a `file:line` citation added to this file or to the ledger is checked by nobody. Open each
one.

A ticket that produced no lesson gets one line saying so. That is the normal outcome, and inventing
one to look thorough is the failure this step exists to prevent.

Changes to the agent files themselves ship as their own pull request, reviewed like any other. The
ledger is the evidence that PR cites.

## 8. Kaizen — improve the loop while you are inside it

The retro *judges* improvements; they are *found* mid-ticket, where raising one costs a message
instead of a re-read. Seven rules, for every agent in the loop, each anchored to something this
loop paid for:

- **Small and continuous beats a rewrite** — what stuck, both restructures, was the paragraph
  tied to an incident; the reorganisations mostly restated the file.
- **Standardise before you improve** — an improvement to an unwritten habit is a preference,
  and a preference cannot be argued with.
- **Go and see** — the loop's strongest rule, "run the tool, not a reimplementation of it",
  exists because a reviewer twice reported a property of a scratch copy as the original's.
- **The improvement belongs to whoever hit the friction** — the binding-block rule came from the
  lead that hit it three times; do not defer to whoever holds the pen.
- **Every proposal carries what it would have caught** — the ledger's bar, applied earlier; a
  proposal with no failure attached is dropped, said so.
- **Retire at the rate you adopt** — a rule silent for ten tickets goes, recorded as unmeasured
  rather than wrong. This section is subject to its own rule.
- **Name what wakes or reaches the recipient before writing any delivery instruction** — if you
  cannot name a runtime mechanism, the instruction is invalid. Six commits went into one channel
  class and the fix for the first caused the third: `ce81fa6` told a subagent to `SendMessage` its
  result, and a resumed subagent has no roster to send with — the instruction fails this test on its
  own text, and `fbf33ac` records what it produced, a send to a guessed name that reached nobody. A
  seventh instance then occurred under the amended wording, which is the argument for giving the
  receiving side a check rather than the sending side another sentence.

And keep asking the rate question: what did the loop catch that the gates would have caught
anyway, and what did it cost to find out? Record unfavourable answers with the same specificity —
a process that only ever produces evidence of its own value is not being measured.

## Coordination artifacts, and what git already provides

**1. Name a SHA, never describe a state** — what the tree looked like, what a reviewer read, what
CI ran against. Prose descriptions have twice hidden a moved file and once hidden an early build.

**2. A coordination artifact that exists only in chat did not happen.** Plans, verdicts, review
output and triage decisions go under `.omc/retro/<ticket>/`, re-readable by an agent that was not
in the conversation; a `SendMessage` body is notification that evidence exists, not the evidence.
And a decision **not** to act is the artifact that vanishes — nothing re-surfaces a commit never
made — so send it to whoever proposed the change: they alone will notice its absence.

**3. The team's history is not the product's history.** Coordination state stays under `.omc/` or
refs outside the ticket branch, never in product commits or the PR diff; the PR body carries the
reasoning, the verdict machinery stays behind it.

**Considered and not adopted**, so the next agent does not re-propose them: `Approved-by:`
trailers and signed commits (rule 3 forbids the noise), `git notes` for verdicts (nothing to
attach to at plan time), and diffing the tree across a verdict to prove reviewer containment
(never violated once — a guard with no incident is the liability this ledger keeps retiring).

## Skin in the game

**Sign the claim.** Every verdict, rejected finding, directive and relayed fact carries who made
it, and a ledger entry for an escaped defect names the stage **and the agent**, including you —
an unattributed error cannot be seen as a pattern, and a pattern is the only thing a ledger can
act on.

**Name the downside and who bears it** before directing a change. A directive whose cost falls
entirely on someone else earns one more look: one reviewer reversed the same design decision
twice and the implementer paid three revisions — cheap only because the plan round moves prose,
which is itself the strongest argument for stopping before implementation.

**When two instructions conflict, the receiver names the conflict to both sources — it does not
pick.** A silent resolution once undrafted a PR against a hold order, and which order came first
could not be established because the only record was chat.

**Do not manufacture justification for a direction you were given.** Object before complying, or
comply with *"complying, not persuaded"* — one implementer wrote a paragraph defending a
direction and deleted it a round later when the direction reversed.

**You cannot be the sole scorer of your own errors.** The `retro` agent reads artifacts, not your
account of them — that is why §3 requires the copies — and where the only record is chat, the
honest entry says the origin cannot be established.
