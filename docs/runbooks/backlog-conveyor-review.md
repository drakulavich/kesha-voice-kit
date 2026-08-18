# Backlog Conveyor Review Runbook

This runbook is the mandatory review sequence for every PR produced by the
backlog conveyor. `CLAUDE.md` contains the binding invariant; this document
defines the durable GitHub evidence and the order of operations for both Codex
and Claude.

## 0. When Greptile counts

A requirement below to obtain **new** Greptile coverage applies **if the
Greptile quota is available**. Grok and the simplify pass are commissioned per
PR, so if either is unavailable nobody looked and the PR is blocked. Greptile
reviews on its own trigger, against a quota this repository does not control;
its absence is a fact about the vendor, not evidence about the change, and
blocking on it would make every conveyor PR unmergeable for the length of an
outage.

The carve-out is narrow:

- It covers **Greptile only**, and only the act of obtaining a new review. An
  unavailable or inconclusive Grok or simplify pass, or a red CI check, remains
  a hard blocker, exactly as `CLAUDE.md` states.
- It never clears a **finding**. Outstanding Greptile P1/P2 from any earlier
  head still block, quota or no quota; an outage stops new coverage arriving, it
  does not retire what already arrived.
- Unavailability must be **recorded on the PR with the head SHA it applies to**,
  in the same comment that carries the rest of that head's evidence, and the
  record must **quote something a stranger can retrieve** — the check rollup
  showing no Greptile context, the bot's own quota comment, an HTTP error, a
  dated status page. Assertion alone is an affidavit, not evidence. This rule
  binds hardest when the quota is down; the opening sentence does not switch it
  off.
- "Available but not finished yet" is not unavailable — that is a wait.
- Availability is judged per head, and re-judged immediately before
  `merge-ready`. A quota that returns — on this head or the next — puts
  Greptile back in the required set.

## 1. Grok review and durable evidence

Run one independent, risk-specific Grok review against the PR's current head.
Do not ask only for a generic review: name the invariant, regression, contract,
or boundary that needs adversarial scrutiny. A private ask artifact is not
enough. Post one PR comment headed `**grok review**` that contains:

- the full reviewed head SHA;
- Grok's verdict; and
- every material finding with severity and enough context for a fresh fix agent
  to act on it, or an explicit `No material findings` verdict.

## 2. Resolve findings in a later pass

Confirmed Grok P1/P2 findings block `merge-ready`. Remove that label first
if it is present, then give the finding comment verbatim to a subsequent fix
pass. The fix pass pushes its own changes; the new head must repeat Grok review
and CI, and must repeat Greptile review only when its quota is available (§0).
A rejected finding needs a PR comment explaining the evidence for rejecting it
and naming the current head SHA. On that SHA, a rejection closes the finding
only when its evidence is sufficient for a fresh agent to verify it. A clean
review means there are no outstanding *confirmed* P1/P2 findings on the current
head; it does not require deleting or rewriting the original review comment.

After three unresolved fix rounds, post the remaining blocker, add
`needs-decision` to the issue, and do not mark the PR ready. P3 findings are
recorded in the Grok comment and handled only when their risk warrants a
follow-up; they do not silently disappear.

## 3. Establish full readiness on one head

Before simplification, verify all evidence refers to the same current PR head:

- the provider-neutral conveyor gate's required checks are green on that head;
- Greptile has covered that head, or its unavailability is recorded for that
  head as §0 requires, and no Greptile P1/P2 is outstanding; and
- the current-head Grok comment is clean, or every confirmed P1/P2 was fixed
  or rejected with SHA-bound evidence on this head.

## 4. Run a simplify pass last

Only after step 3, run a behavior-preserving simplify pass. Use `/simplify <PR>`
when the provider offers it; otherwise use an equivalent provider-neutral pass.
Post a `**simplify**` PR comment with the reviewed head SHA, verdict, and any
material suggestion. If simplification identifies a change or causes one, that
new head restarts at step 1; it needs fresh Grok, CI and a new simplify pass,
plus fresh Greptile only when its quota is available (§0). If no capable
simplify pass is available or its result is inconclusive, record the blocker
and leave the PR without `merge-ready`.

## 5. Mark `merge-ready`

After steps 1–4, apply `merge-ready` only through
`bun run conveyor -- gate --issue <N> --pr <PR> --evidence <path> --apply`
with the existing provider-neutral, SHA-bound evidence object. Do not add the
label by hand, and do not teach the conveyor CLI to parse Grok or simplify
comments. The final PR and ledger note should state that Grok, CI, simplify,
and Greptile all covered that exact SHA — naming Greptile as unavailable where
§0 applies, after re-checking availability at this moment rather than earlier
in the run. Any subsequent push removes `merge-ready` and restarts this
runbook.
