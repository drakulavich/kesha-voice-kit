# CI Fast/Heavy Test-Lane Split

Stop every PR push from downloading the ~2.4 GB model bundle (slow + the source of the `integration-tests` timeout flakes + a cache that's cold across PRs). Split CI integration testing into a **fast lane** that runs on every PR with no model install, and a **heavy lane** that installs real models and runs only when it matters (engine/model changes, push-to-main, nightly).

## Key insight — the split needs (almost) no test changes

The test suite is already cleanly separable:

- **Fake-engine / model-free** (run everywhere): `tests/unit/**`, `tests/integration/say.test.ts`, `cli-contracts.test.ts`, `e2e-cli.test.ts`. These use fake engines — `createFailingEngine`, the inline stub in `e2e-cli` that emits a canned `"Привет с воркшопа"` transcript, and the `cli-scenario` harness. They set `KESHA_ENGINE_BIN` to a fake and never touch real models.
- **Real-engine / model-dependent** (need the 2.4 GB install): `e2e-engine.test.ts`, `mcp-e2e.test.ts`, `say-e2e.test.ts`. All three **already** self-skip when the engine/models are absent:
  - `e2e-engine.test.ts`: `describe.skipIf(!engineInstalled)` (`isEngineInstalled()`).
  - `mcp-e2e.test.ts`: `describe.skipIf(!engineInstalled)` + `test.skipIf(!SPIKE_AVAILABLE)`.
  - `say-e2e.test.ts`: `it.skipIf(!SPIKE_AVAILABLE)`.

So: **if the fast lane does not run `kesha install`, the heavy suites skip themselves and the fast suites run as fakes.** No stub engine to build; the repo already has the fakes and the skip guards.

## Goals

- Every PR push: fast feedback, no multi-GB download, no model cache, no download-contention flake.
- Real-engine coverage (model-format compatibility, real transcribe/synth, TS↔engine wire) still runs — on the changes that can affect it, on `main`, and nightly.
- The model cache becomes a heavy-lane concern only, and push-to-main seeds it in the **default-branch scope** so the heavy lane is warm when it does run.

## Non-goals

- Building a dedicated stub-engine binary (unnecessary — fakes already exist).
- Removing real-engine e2e tests (they catch the highest-severity "shipped engine is broken" class — kept, just gated).
- Changing the release draft-asset smoke gate (the real pre-publish validation in CLAUDE.md stays as-is).
- Touching Rust test lanes (`rust-test.yml`) — unaffected.

## Design

### Lanes (in `.github/workflows/ci.yml`)

1. **`integration-tests` (fast) — every PR + push to main.**
   - Setup bun, `bun link`, **no `kesha install`**, run `bun test tests/unit tests/integration` (or a dedicated `test:integration-fast` script).
   - `e2e-engine` / `mcp-e2e` / `say-e2e` skip via their existing guards; fake suites run.
   - No model cache step, no ffmpeg-apt step needed for the fake suites (confirm none of the fake tests require ffmpeg; `kesha install` is what pulled it in).
   - Fast (~1–2 min), deterministic, no download.

2. **`integration-tests-full` (heavy) — gated.**
   - Runs the existing `install-kesha-backend` action (downloads engine + models, with the model cache) then the full `test:integration`. Heavy suites now execute.
   - **Triggers:**
     - PRs whose `changes` filter hits engine/model paths: `rust/**`, `rust/src/models.rs`, `package.json` (for `keshaEngine.version`), and the heavy test files themselves (`tests/integration/{e2e-engine,mcp-e2e,say-e2e}.test.ts`).
     - `push` to `main` (post-merge) — also warms the **main-scoped** model cache.
     - `schedule:` nightly cron (one run/day) so model-format drift is caught even with no engine PRs.
   - Keep the existing `!startsWith(github.head_ref, 'release/')` guard (release branches can't download the not-yet-published engine; the release-branch-engine-smoke lane already covers them).

3. **`tts-e2e` / `published-engine-smoke`** (currently every-PR, model-downloading): move under the same heavy-lane gating (engine/model path-filter + push-to-main + nightly). They are real-engine/download jobs and don't need to run on doc/TS-only PRs.

### Cache

- Only the heavy lane keeps the `actions/cache@v5` model step (`~/.cache/kesha`, key `${os}-kesha-engine-v1`).
- Because the heavy lane runs on `push: main`, a successful main run saves the cache in the **default-branch scope**, which GitHub shares with all PRs — so when a PR does trigger the heavy lane, it restores instead of re-downloading. (Subject to the 10 GB/repo LRU; acceptable now that far fewer runs populate/evict it.)

### Guardrail against silent gaps

Risk: someone adds a new real-engine test WITHOUT a skip guard; it would then **fail** in the fast lane (no models) instead of skipping. Mitigation: a tiny meta-test in the fast suite that asserts the known model-dependent describe blocks are guarded — OR simpler, document the convention in `tests/integration/README` and rely on the fast-lane CI failing loudly (which surfaces the missing guard immediately). Pick the lightweight doc + loud-failure approach first.

## Verification

- **Local:** run the fast set with no engine installed and confirm `e2e-engine`/`mcp-e2e`/`say-e2e` report `skip` (not `fail`), and unit/cli-contracts/e2e-cli/say pass. (`KESHA_ENGINE_BIN` unset + empty cache dir, or temporarily point `isEngineInstalled()` at a missing path.)
- **PR CI (this PR):** the fast lane runs green with the heavy suites skipped; the heavy lane triggers because this PR touches `.github/**` (or force it once via a label / workflow_dispatch) and passes.
- Confirm `bun test` total still reports the heavy tests as `skip` (not silently dropped) in the fast lane.

## Rollout

Single PR on `ci/split-test-lanes`. Because it only restructures `ci.yml` (+ maybe a `package.json` script and a one-line test-convention doc), it's reviewable in isolation and its own CI run exercises both lanes. No engine release, no version bump.
