## 1. Canary: the ASR test gets its own lane promise (#1223)

- [x] 1.1 Red: add `the_asr_gate_fails_loudly_rather_than_skipping_when_required` to `rust/tests/model_gate.rs` in the shape of the VAD one — with `KESHA_REQUIRE_ASR_TESTS` set and an empty `KESHA_CACHE_DIR` the gate panics naming the flag; without the flag it returns `false`. Fails to compile until 1.2.
- [x] 1.2 Green: add `pub fn asr_model_or_skip(test: &str) -> bool` to `rust/tests/common/mod.rs` mirroring `vad_model_or_skip` (no tier check; `KESHA_REQUIRE_ASR_TESTS` is the promise).
- [x] 1.3 Switch `rust/tests/transcribe_progress_cli.rs` to `common::asr_model_or_skip`, dropping the `RequiredModels::Real` assertion and the `#741` comment that justified it.
- [x] 1.4 Extend the `model_gate.rs` module doc and `.claude/rules/testing.md:25` with `KESHA_REQUIRE_ASR_TESTS` beside the VAD/Vosk/G2P flags; note that no lane sets it.
- [x] 1.5 Prove: `KESHA_REQUIRE_MODEL_TESTS=real` with an empty `KESHA_CACHE_DIR` runs `transcribe_progress_cli` as a skip, not a panic (the canary's exact failure), and `KESHA_REQUIRE_ASR_TESTS=1` with the same cache panics.
- [x] 1.6 Commit: `fix(test): gate the real-ASR transcribe test on KESHA_REQUIRE_ASR_TESTS, not the Kokoro tier flag` — body `Closes #1223`.

## 2. Engine: a missing ASR model is `E_MODEL_MISSING` (#1215)

- [x] 2.1 Red: `asr_gate_reports_resolved_cache_without_model_as_missing` (`rust/src/transcribe/mod.rs`) asserts `code_of(&err) == ErrorCode::ModelMissing`; `rust/tests/error_codes_cli.rs` gains `a_missing_asr_model_is_reported_as_model_missing` (empty `KESHA_CACHE_DIR`, short PCM WAV, `sole_error_event`, `code == "E_MODEL_MISSING"`, exit 1), both `#[cfg(not(feature = "coreml"))]`. Both red on `E_INTERNAL`.
- [x] 2.2 Green: `ensure_asr_installed` bails through `coded_bail!(ErrorCode::ModelMissing, "No transcription models installed. Run: kesha install")`. `asr_gate_reports_unresolvable_home_as_internal` stays green untouched.
- [x] 2.3 `just mutate rust/src/transcribe/mod.rs "ErrorCode::ModelMissing," "ErrorCode::Internal," <the CLI test>` is caught (pass `--manifest-path rust/Cargo.toml`, #1155).
- [x] 2.4 Commit: `fix(engine): report a missing ASR model as E_MODEL_MISSING instead of E_INTERNAL` — body `Closes #1215`.

## 3. Install lock: an owner that does not parse is stale; one that cannot be read is held (#1224)

- [x] 3.1 Red: `tests/unit/install-lock.test.ts` — "a lock whose owner file does not parse is cleared on the first poll": plant `owner-deadbeef.json` = `{not json`, `acquireInstallLock(binPath, 2_000)` resolves, the file is gone, release leaves no `.lock`. Fails today by timing out at 2 s with `E_INSTALL_RACE`.
- [x] 3.2 Red: "a lock directory holding a non-owner file still ends in E_INSTALL_RACE naming the path": plant `README` only, `acquireInstallLock(binPath, 200)` rejects with `code: "E_INSTALL_RACE"` and a message matching `cannot identify[\s\S]*\.lock and re-run`. Green today; pins the non-goal.
- [x] 3.3 Green: `readOwner` returns `LockHolder { token, owner: LockOwner | null } | null` per design D3; the loop treats `owner === null` as stale; the announcement and `waitTimedOut` read `holder?.owner`. Keep the existing `ownerPath` doc comment; do not add a comment that restates D3.
- [x] 3.4 `just mutate src/install-lock.ts "(held === null || lockIsStale(held))" "(held !== null && lockIsStale(held))" bun test tests/unit/install-lock.test.ts -t "does not parse"` is caught.
- [x] 3.4b Greptile P1: distinguish `readFileSync` failure from `JSON.parse` failure — an unreadable owner is held; pinned with a mode-000 live owner; both guards proven by `just mutate`.
- [x] 3.5 Commit: `fix(install): clear a lock whose owner file cannot be read instead of waiting out the stale ceiling` — body `Closes #1224`.

## 4. Spec sync, gate, PR

- [x] 4.1 `openspec validate triage-top3-fixes`; delta under `specs/installation/spec.md` validates.
- [x] 4.2 `just preflight` (Rust gate fires: `rust/**` changed). Scan added lines for Cyrillic and for comments that restate code.
- [x] 4.3 Push `triage-top3`, `gh pr create --base main` with `Closes #1223, closes #1215, closes #1224` in the body; note that #1215 needs an engine release to reach `kesha` users.
- [x] 4.4 Adversarial review aimed at three claims: "the canary's next run skips exactly one test and fails none", "no consumer matched on the old bail's `Error:` prefix or blank lines", "the corrupt-owner unlink cannot remove an owner a peer published in between". `/loop` on the head SHA for CI + Greptile; P1/P2 findings block.
