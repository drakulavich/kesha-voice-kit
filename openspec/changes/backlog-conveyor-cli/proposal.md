# Backlog conveyor CLI

## Why

The backlog conveyor is currently an ignored local prose workflow, so its durable GitHub
labels can drift from pull requests, reviews, CI and worktrees without an executable way to
find or safely repair the disagreement. The repository needs a small, auditable command
instead of another local source of truth.

## What Changes

- Add a tracked Bun command with `sync`, `gate`, and `close` subcommands, deterministic
  human output, and a versioned JSON report.
- Keep GitHub labels and a SHA-bound structured PR comment as durable state; the ignored
  markdown ledger remains non-authoritative.
- Make all mutations opt-in with `--apply`, idempotent, and narrowly constrained to
  reported repairs.

## Non-goals

- Collision scheduling, priority scoring, metrics, auto-merge, or a daemon/database.
- Replacing GitHub labels or importing the ignored markdown ledger.
- Automatically removing a dirty or out-of-repository worktree.

## Impact

- `scripts/backlog-conveyor.ts` — validated GitHub/git boundary and invariant evaluation.
- `scripts/backlog.ts` — Bun CLI parsing, output and exit-code boundary.
- `tests/unit/backlog-conveyor.test.ts` — fixture-only contract coverage.
- `package.json` — tracked `bun run backlog` entry point.
