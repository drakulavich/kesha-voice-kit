# Backlog conveyor coordination

## Why

Phase 1 reconciles lifecycle state, but independent lanes can still begin overlapping
changes or contend for one host's expensive validation resources. Those conflicts need
durable, provider-neutral coordination that remains useful when every lane uses one
authenticated GitHub identity.

## What Changes

- Extend `bun run conveyor` with manifest-driven `plan`, `claim`, and `release` commands
  for repository-path collision coordination through versioned GitHub issue comments.
- Add `lease acquire|release|status` for a host-local named resource, stored below the
  shared Git common directory so every local worktree observes the same state.
- Preserve Phase 1 reports, dry-run defaults, exit codes, and argv-only external calls.

## Non-goals

- Priority scoring, throughput metrics, auto-merge, a daemon, or an external database.
- Starting implementation lanes, tests, or pull requests automatically.
- Any provider-specific marker, model name, GitHub username, or local-agent configuration.
- Coordination across physical hosts.

## Impact

- `scripts/backlog.ts` — command grammar and stable reporting boundary.
- `scripts/backlog-conveyor.ts` — validated GitHub/git/filesystem coordination boundary.
- `tests/unit/backlog-conveyor.test.ts` — fixture and filesystem contract coverage.
- `openspec/changes/backlog-conveyor-coordination/` — executable change contract.
