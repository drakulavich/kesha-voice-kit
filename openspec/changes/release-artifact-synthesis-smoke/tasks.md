## 1. Shared synthesis assertion

- [x] 1.1 Add a `--no-roundtrip` flag to `.github/scripts/smoke-synthesis.ts` that stops after the WAV assertions and skips the transcribe-back leg (D2)
- [x] 1.2 Restrict the voice list to English (`en-am_michael`) when `--no-roundtrip` is set, leaving the default two-voice list untouched for existing callers
- [x] 1.3 Confirm the existing callers in `ci.yml` (`published-engine-smoke`, `windows-engine-smoke`) still pass the flagless form and behave identically

## 2. Pre-upload gate in build-engine.yml

- [x] 2.1 Add `setup-bun` to the `build` job, before the smoke step
- [x] 2.2 Write `${{ matrix.binary }}.version` from `package.json#keshaEngine.version`, mirroring `release-branch-engine-smoke`'s "Mark local engine version" step
- [x] 2.3 Set `KESHA_ENGINE_BIN` to the staged artifact and `KESHA_CACHE_DIR` to a workspace path, job-scoped (D1)
- [x] 2.4 Install English TTS models via `install-kesha-backend` with `cache-write: "false"` and key `${{ runner.os }}-kesha-models-tts-v1` on the linux and windows rows (D3)
- [x] 2.5 Exempt the macOS row: neither of its TTS engines runs on a hosted macOS runner (D4, #678)
- [x] 2.6 Run `bun .github/scripts/smoke-synthesis.ts --no-roundtrip <workdir>` after the existing `--capabilities-json` assertions and before `Upload engine artifact`
- [x] 2.7 Leave every existing assertion in the `Smoke-test binary` step byte-for-byte unchanged

## 3. Static guard

- [x] 3.1 Extend `.github/scripts/check-workflows.ts` to assert `build-engine.yml` contains the synthesis step and that it precedes `Upload engine artifact` (D5)
- [x] 3.2 Add a unit test for that assertion covering both the present and the deleted case

## 4. Verification

- [x] 4.1 `bun test && bunx tsc --noEmit`
- [x] 4.2 Push the branch and confirm `workflow-lint` is green on the head SHA
- [x] 4.3 Dispatch `build-engine.yml` against the branch with an empty `tag` input; confirm the gated rows pass and the `release` job does not run
- [x] 4.4 Record from that run: whether the model cache restored on each platform, and the added wall-clock per row — settles D3's open question and the cache-scope question in the spec's Open Issues
- [x] 4.5 Cache restored in ~44s and the block cost ~55-60s per row, so D3's fallback was not needed

## 5. Land

- [x] 5.1 Open the PR with `Closes #671, closes #636` in the body, linking the dispatch run as acceptance evidence
- [x] 5.2 Note in the PR that a failed release build is recovered by re-running the run, not by cutting a new tag (Risks)
- [ ] 5.3 Wait for CI and Greptile on the head SHA; resolve P1/P2 findings
- [ ] 5.4 After merge, remove the `WIP` label from #671 and #636 if the auto-close did not
