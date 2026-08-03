## 1. Shared synthesis assertion

- [ ] 1.1 Add a `--no-roundtrip` flag to `.github/scripts/smoke-synthesis.ts` that stops after the WAV assertions and skips the transcribe-back leg (D2)
- [ ] 1.2 Restrict the voice list to English (`en-am_michael`) when `--no-roundtrip` is set, leaving the default two-voice list untouched for existing callers
- [ ] 1.3 Confirm the existing callers in `ci.yml` (`published-engine-smoke`, `windows-engine-smoke`) still pass the flagless form and behave identically

## 2. Pre-upload gate in build-engine.yml

- [ ] 2.1 Add `setup-bun` to the `build` job, before the smoke step
- [ ] 2.2 Write `${{ matrix.binary }}.version` from `package.json#keshaEngine.version`, mirroring `release-branch-engine-smoke`'s "Mark local engine version" step
- [ ] 2.3 Set `KESHA_ENGINE_BIN` to the staged artifact and `KESHA_CACHE_DIR` to a workspace path, job-scoped (D1)
- [ ] 2.4 Install English TTS models via `install-kesha-backend` with `cache-write: "false"` and key `${{ runner.os }}-kesha-models-tts-v1` on the linux and windows rows (D3)
- [ ] 2.5 On macOS, name the FluidAudio Kokoro fetch as an explicit download step and inventory the FluidAudio model directory on failure (D4)
- [ ] 2.6 Run `bun .github/scripts/smoke-synthesis.ts --no-roundtrip <workdir>` after the existing `--capabilities-json` assertions and before `Upload engine artifact`
- [ ] 2.7 Leave every existing assertion in the `Smoke-test binary` step byte-for-byte unchanged

## 3. Static guard

- [ ] 3.1 Extend `.github/scripts/check-workflows.ts` to assert `build-engine.yml` contains the synthesis step and that it precedes `Upload engine artifact` (D5)
- [ ] 3.2 Add a unit test for that assertion covering both the present and the deleted case

## 4. Verification

- [ ] 4.1 `bun test && bunx tsc --noEmit`
- [ ] 4.2 Push the branch and confirm `workflow-lint` is green on the head SHA
- [ ] 4.3 Dispatch `build-engine.yml` against the branch with an empty `tag` input; confirm all three rows pass the new gate and the `release` job does not run
- [ ] 4.4 Record from that run: whether the model cache restored on each platform, and the added wall-clock per row — settles D3's open question and the cache-scope question in the spec's Open Issues
- [ ] 4.5 If the cache did not restore or cost more than a cold Kokoro download, drop the cache step per D3's fallback and re-dispatch

## 5. Land

- [ ] 5.1 Open the PR with `Closes #671, closes #636` in the body, linking the dispatch run as acceptance evidence
- [ ] 5.2 Note in the PR that a failed release build is recovered by re-running the run, not by cutting a new tag (Risks)
- [ ] 5.3 Wait for CI and Greptile on the head SHA; resolve P1/P2 findings
- [ ] 5.4 After merge, remove the `WIP` label from #671 and #636 if the auto-close did not
