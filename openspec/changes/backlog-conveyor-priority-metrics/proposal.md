# Backlog conveyor priority and lifecycle metrics

## Why

Phase 3 makes an issue queue explainable without turning prose, a provider identity, or a
model into scheduling authority. It also supplies aggregate lifecycle timing facts so the
conveyor can be improved from observed GitHub state.

## What Changes

- Add versioned manifest-backed `prioritize` assessments and read-only `queue` ordering.
- Add read-only `metrics --since <ISO timestamp>` aggregate PR lifecycle measurements.
- Preserve schema version 1, existing exit codes, dry-run defaults, trusted-marker rules,
  and argv-only GitHub calls.

## Non-goals

- Semantic scoring from prose or an LLM, provider ranking, auto-starting work, label changes,
  auto-merge, a UI, daemon, cron job, or external database.
- Reading the ignored coordination ledger for metrics.

## Impact

- `scripts/backlog-priority.ts` owns pure validation, scoring, ordering, marker parsing, and
  lifecycle aggregation.
- `scripts/backlog-conveyor.ts` owns complete, validated GitHub reads and the applied marker
  boundary.
- `scripts/backlog.ts` owns the CLI grammar and report formatting.
- `tests/unit/backlog-priority.test.ts` provides fake-runner behavioural coverage.
