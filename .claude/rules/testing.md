---
paths:
  - "tests/**"
  - "rust/tests/**"
  - "bunfig.toml"
  - "src/engine.ts"
  - "src/cli/say.ts"
  - "src/cli/main.ts"
  - "src/engine-install.ts"
  - ".github/workflows/ci.yml"
  - ".github/workflows/rust-test.yml"
---

# Test lanes, coverage floors and suite guards

The rules that always apply (TDD, Beck's desiderata, `just mutate`, the flake ban) stay in CLAUDE.md. This file carries the reference that only matters when a test, a suite lane or a coverage floor is in front of you.

Coverage is a merge gate, not a vanity metric. `bun run coverage:check:ts` holds total TS lines at ≥70% plus risk-based floors on the surfaces that invoke, install or route the engine (`src/engine.ts` 80%, `src/cli/say.ts` 50%, `src/cli/main.ts` 35%, `src/engine-install.ts` 15%); `bun run coverage:check:rust` holds Rust at ≥70%. Both are **path-filtered PR jobs** — `ts-coverage` in `ci.yml` feeding `🧪 CI`, `coverage` in `rust-test.yml` feeding `🧪 Rust Tests` — so a docs- or skill-only PR never exercises them, and no release workflow runs coverage at all. Raise a floor when a surface earns it; lowering one needs its reason in the PR body. These are deliberately not per-file ratchets — the floors protect critical paths without inviting coverage-padding tests everywhere else.

Which suite runs where: the `integration-tests` (fast) and `integration-tests-full` (heavy) jobs in `ci.yml` are authoritative — every-PR runs never download the 2.4 GB model bundle. Both jobs carry the reasoning in their own header comments.

Model-dependent suites self-skip, and not uniformly: `e2e-engine` and `mcp-e2e` guard their outer `describe` on `!engineInstalled`, while `mcp-synthesis-e2e` and all of `say-e2e` guard on the Kokoro stand-in plus a source-built engine — an installed engine does not mean the synthesis cases run. A new real-engine test without such a guard breaks the fast lane instead of skipping, which is the intended loud signal, though it may surface as a timeout rather than a clean assertion failure. `say-e2e`'s gate also requires the source-built engine, not just a model — since the Kokoro stand-in is committed, a model-only gate would run it in lanes that never build the binary.

On the Rust side the guard **is** enforced: `KESHA_REQUIRE_MODEL_TESTS` names which weights a lane promised (`mini` or real), every gate in `rust/tests/common/mod.rs` refuses the wrong tier, and `rust/tests/model_gate.rs` is the meta-test — including the exemptions it lists deliberately. `KESHA_REQUIRE_G2P_TESTS` and `KESHA_REQUIRE_VOSK_TESTS` do the same for the two bundles that have no stand-in. The TS side now mirrors it: `tests/integration/README.md` states the convention and `tests/unit/model-suite-guards.test.ts` enforces it, detecting a real-engine suite by its imports only and listing ungated-by-design suites explicitly (#921).

A test that spawns a stub owns its death. `bunfig.toml` preloads `tests/helpers/leak-guard.ts` into every suite, which reaps what a failed, timed-out or interrupted test left behind and fails the run naming it — before that, three stubs sat at `PPID=1` for two and a half days (#1003). Call sites need nothing: `waitForPidFile` tracks the pid it returns, and the per-file pass sweeps the runner's descendants. Convention and reach: `tests/integration/README.md`.
