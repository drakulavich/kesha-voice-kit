## 1. Contract and executable boundary

- [x] 1.1 Add the OpenSpec proposal, design, delta specification, and strict validation
- [x] 1.2 Add `bun run conveyor -- sync|gate|close`, deterministic text/JSON output and stable exit codes

## 2. Risk-first gate

- [x] 2.1 RED: fixture tests for a stale approval SHA, wrong closing issue, and skipped/missing required check
- [x] 2.2 GREEN: validate exact head, independent approval, exact closing reference, default base, mergeability and green required checks
- [x] 2.3 Persist and recover a versioned provider-neutral SHA-bound PR gate marker; make apply idempotent

## 3. Reconciliation and close safety

- [x] 3.1 RED: stale merge-ready and dirty-worktree refusal fixtures
- [x] 3.2 GREEN: report reconciliation findings and apply only reported safe label repairs
- [x] 3.3 RED/GREEN: close idempotently removes WIP and only a clean, listed `.worktrees/` target

## 4. Adversarial validation and delivery

- [x] 4.1 Sabotage exact-head enforcement and prove the targeted test fails; restore and rerun
- [x] 4.2 Sabotage dirty-worktree protection and prove the targeted test fails; restore and rerun
- [x] 4.3 Run targeted tests, type check, OpenSpec strict validation and `just preflight`
- [ ] 4.4 Push a draft PR with `Closes #1032`; verify exact closing reference, draft/head state and clean worktree
