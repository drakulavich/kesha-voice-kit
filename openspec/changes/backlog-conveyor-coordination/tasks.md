## 1. Contract and executable surface

- [x] 1.1 Add the proposal, design, delta spec, and strict validation before code
- [x] 1.2 Add manifest and lease command grammar while preserving Phase 1 behavior

## 2. GitHub collision boundary

- [x] 2.1 RED: add fixture coverage for plans against claims, pull requests, worktrees,
  prefix boundaries, expiry, pagination/trust, self exclusion, shared identities, ordered
  sweep, and concurrent ordering
- [x] 2.2 GREEN: validate manifests and markers, load paginated facts, and implement
  dry-run/apply claim and release idempotently

## 3. Shared local lease boundary

- [x] 3.1 RED: add filesystem coverage for atomic contention, foreign live refusal, expiry
  recovery, idempotent release, shared-common-dir visibility, and unsafe state refusal
- [x] 3.2 GREEN: publish validated lease state atomically below the shared Git common directory

## 4. Adversarial delivery

- [x] 4.1 Sabotage collision enforcement and prove the focused test fails; restore it
- [x] 4.2 Sabotage atomic/live-lease protection and prove the focused test fails; restore it
- [x] 4.3 Run targeted tests, typecheck/lint, strict OpenSpec validation, lease dogfood, and
  `just preflight`
- [x] 4.4 Push a draft PR with `Closes #1034`, verify the closing reference and clean worktree
