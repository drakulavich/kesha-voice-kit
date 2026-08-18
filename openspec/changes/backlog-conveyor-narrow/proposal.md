# Narrow the backlog conveyor to the commands that deliver

## Why

The conveyor CLI grew to ten subcommands across three changes. Driving it for a
full day used three. The other seven have no caller anywhere in the repository —
not CI, not a recipe, not a script; `package.json → conveyor` is the only entry
point, and they appear solely in their own tests.

Measured by delivered outcome: `sync` found and repaired 71 real drifts (36
issues still labelled `WIP` after their pull request merged, 35 stale
`merge-ready` labels) and then converged to zero actions; `gate` caught a
hand-applied `merge-ready` and correctly refused two illegitimate attempts;
`close` is the only command that removes a finished worktree. The remaining
seven produced nothing.

The zero is structural rather than adoption lag. Coordination resolves
collisions between parallel lanes while the conveyor's first invariant is
exactly one ticket in flight, so it cannot pay off while that invariant holds.
Priority scores a queue whose selection rule is "oldest open issue without `WIP`
or `needs-decision`" — and "priority scoring, throughput metrics" were explicit
non-goals of the phase-1 proposal before a later change added them.

## What Changes

- Remove the `plan`, `claim`, `release` and `lease` subcommands and the
  `scripts/backlog-coordination.ts` module they delegate to.
- Remove the `prioritize`, `queue` and `metrics` subcommands and
  `scripts/backlog-priority.ts`.
- Keep `sync`, `gate` and `close` with their schema version, exit codes,
  dry-run default and argv-only GitHub calls unchanged.
- Keep the SHA-bound gate evidence object intact, digest included: two
  different agents may write evidence under one GitHub identity, which is
  exactly the case a payload digest is for.

## Non-goals

- Removing `close`. It is not redundant with `sync`: `sync` reports worktrees as
  findings and is forbidden from acting on them, while `close` is the only path
  to `remove-worktree`.
- Weakening any invariant `sync`, `gate` or `close` already enforces.
- Rewriting coordination later from scratch. If the conveyor ever runs multiple
  lanes, this code should come back out of git history.

## Impact

- `scripts/backlog.ts` — three subcommands, no manifest/lease/queue flags.
- `scripts/backlog-conveyor.ts` — coordination and priority delegation removed;
  `issueNumberFromBranch` moves here because `sync` uses it.
- `scripts/backlog-coordination.ts`, `scripts/backlog-priority.ts` — deleted.
- `tests/unit/backlog-coordination.test.ts`, `tests/unit/backlog-priority.test.ts` — deleted.
