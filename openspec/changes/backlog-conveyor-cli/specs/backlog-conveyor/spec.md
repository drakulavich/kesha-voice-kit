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
branch, exactly `[N]` in `closingIssuesReferences`, verified provider-neutral approval evidence
for the current head SHA, and terminal successful results for every real required check. A
distinct GitHub reviewer account MUST NOT be required, so multiple orchestrators may use one
authenticated GitHub identity. A current-head native `CHANGES_REQUESTED` from someone other
than the PR author MUST block; native `APPROVED` and `COMMENTED` reviews are supplemental. A required
check with a protected `app_id` MUST match that app, and its latest matching attempt by
start/creation time MUST be authoritative. A stacked or non-default-base PR MUST be ineligible. Under `--apply`, a
versioned machine-readable PR comment MUST bind the marker to the current SHA before
`merge-ready` is added. The evidence object MUST itself declare `version: 1` and remain
provider-neutral: any non-empty `provider`, `verdict: APPROVED`, exact head SHA, evidence
URI/path, and SHA-256 digest of fixed-order canonical evidence bytes excluding that digest.
The command MUST read markers from all comment pages and accept only the newest valid marker
authored by an owner, member, or collaborator. `sync` MUST re-evaluate the same current-head
gate policy before preserving `merge-ready`; marker association alone MUST NOT establish
eligibility. The latest decisive current-head review state per independent reviewer MUST apply:
any current change request blocks, while later comments do not cancel an approval when present.
The command MUST NOT depend on a named agent, model, local settings,
or provider-specific artifact format.

#### Scenario: Ira sees approval evidence made before a push

- GIVEN approval evidence on SHA `a` and PR head SHA `b`
- WHEN Ira runs `gate --issue 1032 --pr 1040`
- THEN it exits with an invariant violation

#### Scenario: Ira and a second orchestrator share one marker

- GIVEN Ira supplies evidence from provider `review-system-a` for a current head
- AND a second orchestrator supplies the same valid evidence schema with provider `future-agent-b`
- WHEN either runs `bun run conveyor -- gate --issue 1032 --pr 1040 --evidence path --apply`
- THEN the marker is readable by both and no provider name is special-cased
- AND a repeated apply preserves the existing marker and `merge-ready` without a duplicate mutation

#### Scenario: Ira encounters a skipped required check

- GIVEN a required context with a skipped or pending result on the current head
- WHEN Ira runs `gate --issue 1032 --pr 1040`
- THEN it exits with an invariant violation

#### Scenario: Maks sees a newer successful attempt after an older failure

- GIVEN a protected required check from app `17` has an older failed attempt and a newer successful attempt on the current head
- WHEN Maks runs `gate --issue 1032 --pr 1040`
- THEN the gate accepts the check based on the newer attempt

#### Scenario: Sona sees a valid-looking untrusted marker

- GIVEN the newest valid-looking marker was authored by an untrusted external contributor
- WHEN Sona runs `sync` or `gate`
- THEN the marker is ignored and cannot preserve or create merge eligibility

#### Scenario: Ira sees a marker written by the PR author who is a repository owner

- GIVEN the marker is current and syntactically valid but its evidence does not match the current head
- WHEN Ira runs `sync`
- THEN it reports `merge-ready` stale and may remove only that label under `--apply`

#### Scenario: Sona and Maks share one GitHub identity

- GIVEN Sona and Maks use different evidence providers but one authenticated GitHub account
- WHEN either runs `gate` with valid current-head evidence and no blocking native review
- THEN the gate accepts the evidence without requiring a distinct GitHub reviewer login

#### Scenario: Maks receives altered evidence

- GIVEN evidence has a digest that does not equal the fixed-order canonical payload excluding the digest
- WHEN Maks runs `gate` or reads the marker
- THEN the command rejects the evidence

#### Scenario: Ira cannot load current checks

- GIVEN GitHub refuses or returns malformed required check data during `sync --apply`
- WHEN Ira runs the command
- THEN it exits operationally before any label mutation

### Requirement: Sync and close SHALL preserve worktree safety

`sync` SHALL report stale merge-ready markers, WIP state left by a closed or merged PR, and
missing, dirty, or orphan local worktrees. It SHALL remove WIP automatically only after the
linked issue is closed, and it SHALL deduplicate every safe mutation before `--apply`.
`close --issue N --pr P` SHALL verify closed/merged PR and issue state consistency; under
`--apply` it SHALL remove WIP and only a clean, listed matching worktree that is a real direct
child of the repository's `.worktrees/` directory. It MUST refuse a dirty, nested, symlinked,
unlisted, or outside target, MUST emit no safe action when it refuses, and MUST NOT force
removal.

#### Scenario: Ira closes an already-cleaned merged item

- GIVEN the PR is merged, the issue is closed, no WIP label remains, and no matching worktree exists
- WHEN Ira runs `close --issue 1032 --pr 1040 --apply`
- THEN it succeeds without a mutation

#### Scenario: Ira tries to close a dirty worktree

- GIVEN the matching worktree has uncommitted changes
- WHEN Ira runs `close --issue 1032 --pr 1040 --apply`
- THEN it refuses the mutation and leaves the worktree intact

#### Scenario: Sona sees a closed unmerged PR while the issue remains open

- GIVEN the issue is open with WIP and a linked PR was closed without merging
- WHEN Sona runs `sync --apply`
- THEN it reports the retained WIP and does not remove it

#### Scenario: Maks sees two historical PRs for one closed issue

- GIVEN two closed or merged PRs reference one closed issue with WIP
- WHEN Maks runs `sync --apply`
- THEN the WIP removal is applied at most once
