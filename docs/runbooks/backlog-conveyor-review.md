# Backlog Conveyor Review Runbook

This runbook is the mandatory review sequence for every PR produced by the
backlog conveyor. `CLAUDE.md` contains the binding invariant; this document
defines the durable GitHub evidence and the order of operations for both Codex
and Claude.

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

Confirmed Grok P1/P2 findings block `merge-ready`. Remove that label first if
it is present, then give the finding comment verbatim to a subsequent fix pass.
The fix pass pushes its own changes; the new head must repeat Grok review,
Greptile review, and CI. A rejected finding needs a PR comment explaining the
evidence for rejecting it.

After three unresolved fix rounds, post the remaining blocker, add
`needs-decision` to the issue, and do not mark the PR ready. P3 findings are
recorded in the Grok comment and handled only when their risk warrants a
follow-up; they do not silently disappear.

## 3. Establish full readiness on one head

Before simplification, verify all evidence refers to the same current PR head:

- required CI is green and a real applicable gate ran, rather than a
  path-filtered no-op;
- Greptile has covered that head when its review service is available; and
- the current-head Grok comment is clean, or every confirmed P1/P2 was fixed
  and re-reviewed on this head.

## 4. Run `/simplify` last

Only after step 3, run `/simplify <PR>`. Post a `**simplify**` PR comment with
the reviewed head SHA, verdict, and any material suggestion. If simplification
identifies a change or causes one, that new head restarts at step 1; it needs
fresh Grok, Greptile, CI, and a new simplify pass. If `/simplify` is unavailable
or inconclusive, record the blocker and leave the PR without `merge-ready`.

## 5. Mark `merge-ready`

Add `merge-ready` only when the current head has the evidence from steps 1–4.
The final PR and ledger note should state that Grok, CI, Greptile, and simplify
all covered that exact SHA. Any subsequent push removes `merge-ready` and
restarts this runbook.
