# Design — backlog conveyor CLI

## Context

Labels remain the durable external truth, while a gate needs durable evidence that can be
recovered by another checkout. A GitHub PR comment containing a small versioned JSON marker
binds the approval and CI decision to one exact head SHA. It is not an ignored local ledger.

## Decisions

### A repository-local Bun script owns the command boundary

`package.json` exposes `bun run backlog -- <subcommand>`. `scripts/backlog.ts` parses only
the phase-1 flags and maps results to stable exit codes. `scripts/backlog-conveyor.ts` holds
the pure decision logic and a narrow runner interface so fixture tests never contact GitHub
or a user worktree.

### GitHub facts are queried at the exact object boundary

The command obtains PR state/reviews/closing references through GraphQL, commit checks by
the current `headRefOid` through the REST API, and required contexts from the default branch
protection endpoint. Every JSON response is shape-checked before use. Commands use argv
arrays exclusively; no user-controlled input is interpolated in a shell.

### Gate evidence is SHA-bound and independently approved

`gate` accepts only an open, non-draft, mergeable PR to the default branch, with exactly the
requested closing issue. An `APPROVED` review by someone other than the PR author must name
the current head SHA. Required contexts are read from branch protection and each matching
check/status must be terminal and successful; skipped, pending, absent, or non-successful
contexts fail. The gate comment records schema version, issue, PR, head SHA and the approval
evidence. A later `sync` removes `merge-ready` when this marker no longer matches the head.

### Worktree deletion is deliberately harder than label cleanup

`close --apply` only removes a clean worktree that is listed by Git and resolves underneath
the repository's exact `.worktrees/` directory. A dirty candidate, an unlisted path, or a
path outside that directory is refused; the command never supplies force.

## Risks / Trade-offs

- Branch protection has no required checks: gate refuses rather than treating a green-looking
  optional check as a required one.
- Review evidence is intentionally rejected after a push; the reviewer must approve the new
  SHA, avoiding approval carry-over.
- `sync` reports missing, dirty, and orphan worktrees but only applies label repairs that it
  explicitly reported as safe.

## Technical notes

- `scripts/backlog.ts:1` is the only user-facing CLI/parser/output boundary.
- `scripts/backlog-conveyor.ts:1` validates `gh`/`git` JSON and owns all argv construction.
- `Justfile:40` defines the canonical repository `.worktrees/<slug>` convention used by the
  close safety boundary.
