## Why

The 2026-09-17 triage put three small defects at the top of the queue, each a contract the code already claims and does not keep: the weekly real-model canary has been red since #1216 landed a test that reads `KESHA_REQUIRE_MODEL_TESTS=real` as "real ASR weights are staged" in a lane that stages only TTS weights (#1223); the Engine reports a missing ASR model as the uncoded `E_INTERNAL` ("file a bug") where `openspec/specs/engine-contract` already promises `E_MODEL_MISSING` (#1215); and an install lock whose owner file cannot be parsed makes `kesha install` wait the full 6 h stale ceiling before failing, when an ownerless lock directory is cleared in milliseconds (#1224). All three are a few lines each and ship together because none is worth its own release cycle, and the canary refiles its issue every Sunday until fixed.

## What Changes

- **Canary (#1223):** the real-ASR transcribe test in `rust/tests/transcribe_progress_cli.rs` stops treating the Kokoro tier flag as a promise about Parakeet. It gains its own `KESHA_REQUIRE_ASR_TESTS` gate, following the `KESHA_REQUIRE_VAD_TESTS` / `KESHA_REQUIRE_VOSK_TESTS` / `KESHA_REQUIRE_G2P_TESTS` precedent (#990): skips when the ASR model is not cached and no lane promised it, fails loudly when a lane set the flag and the weights are absent. `rust/tests/model_gate.rs` pins the new gate and lists it in the exemption policy. No lane sets the flag yet — the canary's stated scope is TTS weights and stays so.
- **Engine (#1215):** `ensure_asr_installed` in `rust/src/transcribe/mod.rs` bails through `coded_bail!(ErrorCode::ModelMissing, …)` with the same "No transcription models installed … kesha install" text, so a bare-cache `kesha-engine transcribe` emits one `E_MODEL_MISSING` error event. The #969 behaviour — a null home stays `E_INTERNAL` — is unchanged. Pinned at the unit level (code assertion added to the existing resolved-cache test) and at the CLI level in `rust/tests/error_codes_cli.rs` with an empty `KESHA_CACHE_DIR`.
- **Install lock (#1224):** `src/install-lock.ts::readOwner` distinguishes "no owner file", "an owner file that does not parse" and "an owner file that cannot be read". An unparseable owner is treated as stale: its file is unlinked by the exact name it has, then the directory is removed, so a foreign or corrupt owner costs one poll rather than the stale ceiling. An owner file that cannot be read (EACCES, EIO) is a live holder and is waited on, as today — a read failure says nothing about the install behind it (Greptile P1 on #1225). A lock directory holding something that is not an owner file still cannot be cleared and still ends in `E_INSTALL_RACE` after the wait, as today.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `installation`: adds the requirement that concurrent installs sharing one Engine directory are serialised by a lock, that a lock whose owner is dead, expired **or does not parse** is cleared by the next waiter rather than waited out (one that cannot be read at all stays held), and that giving up is `E_INSTALL_RACE`. The serialisation itself has been the behaviour since #997 but was never a stated requirement; the unparseable-owner clause is the new behaviour.

`engine-contract` already carries the scenario "the ASR model is not installed → `E_MODEL_MISSING`" (`### Requirement: Every failure is one error event` block); #1215 is implementation drift from it, so no delta is needed there.

## Impact

- `rust/src/transcribe/mod.rs` (one bail site), `rust/tests/error_codes_cli.rs`, `rust/tests/transcribe_progress_cli.rs`, `rust/tests/common/mod.rs`, `rust/tests/model_gate.rs` — Engine crate only; the CLI's pre-spawn `E_MODEL_MISSING` checks are untouched. Ships with the next engine release; the CLI pin is not bumped here.
- `src/install-lock.ts`, `tests/unit/install-lock.test.ts` — CLI; no public API change, no new env var.
- `.github/workflows/real-model-canary.yml` — no change to what it downloads; only its suite stops failing on the ASR gate. `docs/` gains the new `KESHA_REQUIRE_ASR_TESTS` flag wherever the sibling `KESHA_REQUIRE_VAD_TESTS` is listed.
- Closes #1223, #1215, #1224.

## Non-goals

- Staging real Parakeet weights in the canary. That is a ~2.4 GB weekly download the lane's own comment refuses (#741); whether any lane should ever require real ASR is a separate decision.
- Failing fast on an ownerless lock directory that holds a non-owner file. The issue scopes `E_INSTALL_RACE` after the wait as the fallback for a directory that genuinely cannot be cleared; shortening that wait is a different change.
- #1202 (`origin` of `E_MODEL_MISSING` / `E_TEXT_*` in `describe`) — same engine release, separate PR.
- Bumping the CLI's engine pin or cutting a release.
