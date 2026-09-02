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
               You own this ticket end to end. Your protocol is
               <abs path>/.claude/skills/ticket-team/PROTOCOL.md — read it first.
               Report to me once, when the pull request is handed off.")
```

That is the whole of your involvement — no sizing, relaying, digest checks, triage, hand-off
decisions or ledger writes. If you are composing a message about the ticket's *content*, you have
rejoined a loop you were removed from. A relay reads snapshots, and its snapshot is by
construction older than the participants'.

**Do not run tools on the lead's behalf** — not `Agent`, not `Write`, not "mechanically, without
judging it". A lead's tool list is a boundary, and executing around it makes you the acting party
for a decision you were removed from; the session that wrote this file offered exactly that,
unprompted, and the lead rightly refused. A lead missing a tool says so, and **the maintainer
decides**.

Idle notifications mean "available", not "here is my output" — ignore them; the lead reports
once. What stays yours: stopping or re-scoping the ticket on the maintainer's word, and relaying
— verbatim, never composing — an answer only the maintainer can give.

---

The lead's protocol is `PROTOCOL.md` beside this file; pass its absolute path in the spawn prompt.
