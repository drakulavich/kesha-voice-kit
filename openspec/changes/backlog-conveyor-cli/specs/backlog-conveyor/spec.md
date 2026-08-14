## ADDED Requirements

### Requirement: The repository SHALL expose a safe backlog conveyor command

The repository SHALL expose `bun run conveyor -- sync|gate|close`. Each subcommand MUST emit
deterministic human-readable output by default and a JSON report with a declared schema
version under `--json`. Mutating actions MUST be dry-run unless `--apply` is passed and
repeating an applied command MUST be idempotent. The command SHALL use distinguishable exit
codes for success, invariant violation, operational failure, and unsafe/refused mutation.

#### Scenario: Ira previews a reconciliation

- GIVEN GitHub and local worktree facts
- WHEN Ira runs `bun run conveyor -- sync --json`
- THEN the report has the declared schema version and lists findings/actions
- AND GitHub labels and worktrees are unchanged

#### Scenario: Ira repeats an applied repair

- GIVEN a prior `--apply` repaired the reported label state
- WHEN Ira repeats the same command with `--apply`
- THEN it succeeds without duplicating a comment, label mutation, or deletion

### Requirement: Gate SHALL bind independent approval and checks to one head SHA

`gate --issue N --pr P --evidence path` SHALL require an open, non-draft, mergeable PR to the default
branch, exactly `[N]` in `closingIssuesReferences`, an independent `APPROVED` review for the
current head SHA, and terminal successful results for every real required check. A stacked
or non-default-base PR MUST be ineligible. Under `--apply`, a versioned machine-readable
PR comment MUST bind the marker to the current SHA before `merge-ready` is added. The evidence
object MUST be versioned and provider-neutral: any non-empty `provider`, `verdict: APPROVED`,
exact head SHA, evidence URI/path, and SHA-256 digest. The command MUST NOT depend on a named
agent, model, local settings, or provider-specific artifact format.

#### Scenario: Ira sees a review made before a push

- GIVEN an approval on SHA `a` and PR head SHA `b`
- WHEN Ira runs `gate --issue 1032 --pr 1040`
- THEN it exits with an invariant violation

#### Scenario: Ira and a second orchestrator share one marker

- GIVEN Ira supplies evidence from provider `review-system-a` for a current head
- AND a second orchestrator supplies the same valid evidence schema with provider `future-agent-b`
- WHEN either runs `bun run conveyor -- gate --issue 1032 --pr 1040 --evidence path --apply`
- THEN the marker is readable by both and no provider name is special-cased
- AND it does not add `merge-ready`

#### Scenario: Ira encounters a skipped required check

- GIVEN a required context with a skipped or pending result on the current head
- WHEN Ira runs `gate --issue 1032 --pr 1040`
- THEN it exits with an invariant violation

### Requirement: Sync and close SHALL preserve worktree safety

`sync` SHALL report stale merge-ready markers, WIP state left by a closed or merged PR, and
missing, dirty, or orphan local worktrees. It SHALL remove only explicitly reported safe
labels under `--apply`. `close --issue N --pr P` SHALL verify closed/merged PR and issue
state consistency; under `--apply` it SHALL remove WIP and only a clean, listed matching
worktree directly underneath the repository's `.worktrees/` directory. It MUST refuse a
dirty, unlisted, or outside target and MUST NOT force removal.

#### Scenario: Ira closes an already-cleaned merged item

- GIVEN the PR is merged, the issue is closed, no WIP label remains, and no matching worktree exists
- WHEN Ira runs `close --issue 1032 --pr 1040 --apply`
- THEN it succeeds without a mutation

#### Scenario: Ira tries to close a dirty worktree

- GIVEN the matching worktree has uncommitted changes
- WHEN Ira runs `close --issue 1032 --pr 1040 --apply`
- THEN it refuses the mutation and leaves the worktree intact
