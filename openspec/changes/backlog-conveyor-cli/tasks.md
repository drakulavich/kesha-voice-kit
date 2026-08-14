## 1. Contract and executable boundary

- [ ] 1.1 Add the OpenSpec proposal, design, delta specification, and strict validation
- [ ] 1.2 Add `bun run conveyor -- sync|gate|close`, deterministic text/JSON output and stable exit codes

## 2. Risk-first gate

- [ ] 2.1 RED: fixture tests for a stale approval SHA, wrong closing issue, and skipped/missing required check
- [ ] 2.2 GREEN: validate exact head, independent approval, exact closing reference, default base, mergeability and green required checks
- [ ] 2.3 Persist and recover a versioned provider-neutral SHA-bound PR gate marker; make apply idempotent

## 3. Reconciliation and close safety

- [ ] 3.1 RED: stale merge-ready and dirty-worktree refusal fixtures
- [ ] 3.2 GREEN: report reconciliation findings and apply only reported safe label repairs
- [ ] 3.3 RED/GREEN: close idempotently removes WIP and only a clean, listed `.worktrees/` target

## 4. Adversarial validation and delivery

- [ ] 4.1 Sabotage exact-head enforcement and prove the targeted test fails; restore and rerun
- [ ] 4.2 Sabotage dirty-worktree protection and prove the targeted test fails; restore and rerun
- [ ] 4.3 Run targeted tests, type check, OpenSpec strict validation and `just preflight`
- [ ] 4.4 Push a draft PR with `Closes #1032`; verify exact closing reference, draft/head state and clean worktree
