## ADDED Requirements

### Requirement: The conveyor SHALL record explainable priority assessments without provider identity authority

The conveyor SHALL accept `prioritize --manifest <path> [--apply] [--json]` with a version 1
manifest containing a positive existing open issue, opaque non-empty provider, integer impact, urgency,
unblock, and riskReduction values in 0..5, confidence and effort values in 1..5, and a concise
rationale. It SHALL derive, rather than accept, the two-decimal score
`round(((4*impact + 3*urgency + 2*unblock + 2*riskReduction) * confidence / effort) * 100) / 100`.
The command SHALL remain dry-run unless applied, publish a versioned structured marker when
needed, trust only OWNER, MEMBER, or COLLABORATOR markers, and reread all pages after a write.
A repeated identical current assessment SHALL be idempotent, and the latest trusted marker by
`(createdAt, databaseId)` SHALL supersede earlier assessments.

#### Scenario: Ira applies an assessment

- GIVEN Ira has a valid version 1 manifest for open issue 1036
- WHEN Ira runs `prioritize --manifest assessment.json --apply --json`
- THEN the report accepts the exact current structured marker and its computed score
- AND no provider value is treated as an account identity

#### Scenario: Maks supplies an unsafe marker

- GIVEN a trusted comment carries the priority marker prefix with malformed JSON
- WHEN Maks runs `prioritize` or `queue`
- THEN the conveyor fails closed without publishing an assessment

### Requirement: The conveyor SHALL present a deterministic assessed issue queue

The conveyor SHALL expose `queue [--label <name>] [--limit <N>] [--json]` as a read-only view
of open issues and trusted priority markers. It SHALL exclude WIP, needs-decision, and wontfix
labels and pull requests; sort assessed entries by descending score, then oldest creation time,
then issue number; and place visible unassessed entries at score zero after assessed entries.
It SHALL emit score components and rationale, honour an exact optional label, and fail closed on
incomplete pagination or malformed trusted markers.

#### Scenario: Sona views a mixed queue

- GIVEN two assessed visible issues and one unassessed visible issue
- WHEN Sona runs `queue --json`
- THEN the assessed issues appear in deterministic score order followed by the unassessed issue

#### Scenario: Ira reaches an incomplete page cap

- GIVEN the open issue listing reaches its configured cap
- WHEN Ira runs `queue`
- THEN the conveyor returns an operational failure instead of a partial queue

### Requirement: The conveyor SHALL aggregate lifecycle metrics from GitHub facts and trusted gates

The conveyor SHALL expose read-only `metrics --since <ISO timestamp> [--json]` using GitHub
issue and PR facts and trusted gate markers only. It SHALL reject `since` after its report upper
bound; include merged counts and merge-ended samples only for `mergedAt` within inclusive bounds;
include gated counts and open→gate samples only for trusted gate-marker creation within bounds;
allow an earlier valid gate for merge-ended samples; and count all currently open WIP and
merge-ready issues regardless of bounds. It SHALL report sample size, median, and nearest-rank
p90 for valid PR-open→gate, gate→merge, and PR-open→merge durations. It SHALL use null for an
empty sample, reject negative or non-finite chronology, and never read the ignored ledger.

#### Scenario: Maks measures a completed lifecycle

- GIVEN a trusted gate marker and merged PR after the lower bound
- WHEN Maks runs `metrics --since 2026-08-01T00:00:00Z --json`
- THEN the report includes its valid lifecycle samples and aggregate percentiles

#### Scenario: Sona has no gate-to-merge samples

- GIVEN no PR has both a valid gate time and merge time in the window
- WHEN Sona runs `metrics --since 2026-08-01T00:00:00Z`
- THEN gate-to-merge metrics are null rather than zero

#### Scenario: Ira supplies an invalid metric window

- GIVEN Ira supplies a `since` timestamp after the report upper bound
- WHEN Ira runs `metrics`
- THEN the conveyor rejects the invalid window instead of producing a partial aggregate

> _Technical Note — sources: `scripts/backlog.ts` owns CLI parsing and report output;
> `scripts/backlog-conveyor.ts` owns validated GitHub pagination; `scripts/backlog-priority.ts`
> owns pure assessment and aggregate lifecycle policy._
