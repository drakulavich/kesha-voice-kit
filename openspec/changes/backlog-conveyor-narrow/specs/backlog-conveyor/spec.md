## REMOVED Requirements

### Requirement: The conveyor SHALL plan and claim repository path ownership without provider identity

**Reason**: Path-collision coordination exists to keep parallel lanes from
overlapping. The conveyor's governing invariant is exactly one ticket in flight,
so no two lanes can contend for a path while it holds. Measured over a full day
of operation the `plan`, `claim` and `release` subcommands were invoked zero
times and have no caller outside their own tests.

**Migration**: None required — no workflow, recipe or script referenced them.
Reintroduce from git history if the conveyor ever runs multiple lanes.

### Requirement: The conveyor SHALL safely serialize a host-local named heavy resource

**Reason**: The lease guards one host's expensive validation resource against
concurrent lanes, and shares the single-lane fate of the claim commands. Zero
invocations, zero callers.

**Migration**: None required. Serialising a heavy local gate remains achievable
with any host-local lock if a second lane ever appears.

### Requirement: The conveyor SHALL record explainable priority assessments without provider identity authority

**Reason**: Ticket selection is "the oldest open issue carrying neither `WIP` nor
`needs-decision`" — one `jq` expression against `gh issue list`. Scoring never
changed which ticket was taken. "Priority scoring" was an explicit non-goal of
the phase-1 proposal before a later change introduced it.

**Migration**: None required. `gh issue list --json number,createdAt,labels`
reproduces the selection the conveyor actually used.

### Requirement: The conveyor SHALL present a deterministic assessed issue queue

**Reason**: The queue renders the assessments removed above; without them it
orders nothing that the selection rule does not already order.

**Migration**: None required.

### Requirement: The conveyor SHALL aggregate lifecycle metrics from GitHub facts and trusted gates

**Reason**: Every lifecycle question asked of the conveyor so far was answered
by querying GitHub directly at the moment it was asked, against a window chosen
for that question. A stored aggregate answered none of them and was never run.

**Migration**: None required — the same facts remain available from
`gh pr list` and `gh api`.
