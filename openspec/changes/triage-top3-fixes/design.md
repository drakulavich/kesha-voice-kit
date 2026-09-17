## Context

Three independent defects, each a few lines, bundled because they share a queue position rather than a module. See `proposal.md` for the why; the current state of each:

- **#1223** — `rust/tests/transcribe_progress_cli.rs:17-24` asserts `common::models_required() != Some(RequiredModels::Real)` when the ASR model is not cached. `KESHA_REQUIRE_MODEL_TESTS` is the Kokoro *tier* flag (`mini` / real, `rust/tests/common/mod.rs:92-109`): it says which weights the lane staged for the TTS gates, and no lane that sets it to `real` (`real-model-canary.yml:49`) stages Parakeet. The precedent for a model with no stand-in and its own lane promise is `KESHA_REQUIRE_VAD_TESTS` (`common::vad_model_or_skip`, #990).
- **#1215** — `rust/src/transcribe/mod.rs:1042-1051 ensure_asr_installed` uses `anyhow::bail!`; the neighbouring `lang_id.rs:70-81` uses `coded_bail!(ErrorCode::ModelMissing, …)` for the same situation. `rust/src/transcribe/mod.rs:1863` already pins the message text on a resolved-but-empty cache; `:1842` pins that a null home stays `E_INTERNAL` (#969).
- **#1224** — `src/install-lock.ts:54-68 readOwner` returns `null` both for "no owner file" and "owner file present but `JSON.parse` throws". The acquire loop (`:243-246`) passes `holder?.token ?? null` to `clearLock`, which with a null token skips the unlink and `rmdirSync` fails on the non-empty directory, so the loop takes the *held* branch with nothing to judge stale.

## Goals / Non-Goals

**Goals:**

- The canary goes green on the next scheduled run without changing what it downloads.
- `kesha-engine transcribe` on an empty Model cache emits one `E_MODEL_MISSING` error event; every existing assertion on the message text and on the #969 ordering keeps passing.
- A lock directory holding an unparseable `owner-*.json` is cleared on the first poll.

**Non-Goals:**

- Staging Parakeet in any Rust CI lane; fast-failing on a non-owner file in the lock directory; #1202; the engine pin bump. All listed in the proposal.

## Decisions

### D1 — A separate `KESHA_REQUIRE_ASR_TESTS` flag, not a broader meaning for the tier flag

`common::asr_model_or_skip(test: &str) -> bool` mirrors `vad_model_or_skip`: returns `true` when `models::is_cached(ModelKind::Asr)`; otherwise asserts `KESHA_REQUIRE_ASR_TESTS` is unset, prints the skip line, returns `false`. The tier check (`assert_staged_tier_matches`) is deliberately not applied — Parakeet has no mini stand-in, exactly the reason #990 gave for Silero.

*Alternatives:* (a) stage Parakeet in the canary — 2.4 GB weekly against a lane whose comment refuses a 1.4 GB cache entry, and it changes the canary's stated scope; (b) keep the tier flag and set it only in a lane that stages both — no such lane exists, and the flag's documented meaning (`common/mod.rs:99-100`, "anything else truthy demands real weights") would still be a lie in the canary; (c) delete the loud branch and always skip — that is the #741 silence the gate exists to prevent.

`rust/tests/model_gate.rs` gets one test in the shape of `the_vad_gate_fails_loudly_rather_than_skipping_when_required`, and its module doc lists the new flag beside the VAD one. No workflow sets the flag in this change; the developer who runs `kesha install` locally is the one who runs the test today, and that is unchanged.

### D2 — `coded_bail!(ErrorCode::ModelMissing, …)` with the message text kept

Message becomes `"No transcription models installed. Run: kesha install"` — the `Error:` prefix and blank lines of the current bail are rendering the CLI already does, and `lang_id.rs:76` sets the house style. `diarize_e2e.rs:227` matches on the substring `No transcription models installed` and keeps matching. Hint derivation is whatever `Event::error` does for `ModelMissing` today; not touched.

Tests: the existing `asr_gate_reports_resolved_cache_without_model_as_missing` gains `assert_eq!(code_of(&err), ErrorCode::ModelMissing)` (red first — today it is `Internal`); `rust/tests/error_codes_cli.rs` gets `a_missing_asr_model_is_reported_as_model_missing` spawning `transcribe` on a real short WAV (`common::write_pcm16_wav`) with `KESHA_CACHE_DIR` pointing at an empty temp dir, asserting `common::sole_error_event` has `code == "E_MODEL_MISSING"` and exit 1. Both `#[cfg(not(feature = "coreml"))]` for the reason the unit test states: on CoreML `is_cached_in(Asr, …)` ignores the dir.

### D3 — `readOwner` reports the token of an unreadable owner; the loop treats it as stale

```ts
interface LockHolder { token: string; owner: LockOwner | null }
function readOwner(lockDir): LockHolder | null   // null ⇒ no owner file at all
```

Token comes from the filename (`owner-<token>.json`), so `ownerPath(lockDir, token)` reconstructs the exact name and `clearLock`'s unlink-by-name exclusion (the `ownerPath` doc comment) still holds: two waiters clearing the same corrupt owner race on one unlink, one wins. The loop:

```ts
const holder = readOwner(lockDir);
const stale = holder === null || holder.owner === null || lockIsStale(holder.owner);
if (stale && clearLock(lockDir, holder?.token ?? null)) continue;
```

`waitTimedOut` and the wait announcement take `holder?.owner ?? null`, so a corrupt owner that could not be cleared is still "an install it cannot identify" rather than `pid NaN`.

*Alternative:* synthesise a fake `LockOwner { startedAt: 0 }` from the filename so `lockIsStale` fires by age. Fewer lines, but it prints `pid undefined on undefined` in the wait line and confuses a real owner with a corrupt one everywhere the record is read. Rejected.

Tests (`tests/unit/install-lock.test.ts`, in-process, not `posixTest`): plant `owner-deadbeef.json` containing `{not json`, `acquireInstallLock(binPath, 2_000)` resolves and the corrupt file is gone; plant a non-owner file `README` only, expect `E_INSTALL_RACE` with `cannot identify` after a 200 ms ceiling. The second pins the non-goal so a later "fix" of it is a deliberate spec change.

## Risks / Trade-offs

- [The canary still exercises no real ASR] → It never did; the test was the only thing claiming otherwise. Recorded in the proposal's non-goals and in the `model_gate.rs` module doc so the exemption is visible.
- [A lane later sets `KESHA_REQUIRE_MODEL_TESTS=real` *and* stages Parakeet, expecting the ASR test to be loud] → It must also set `KESHA_REQUIRE_ASR_TESTS`; the model-gate doc says so.
- [Changing the bail's message shape breaks a TS-side substring match] → grep found one consumer (`diarize_e2e.rs`) and it matches the kept substring; `docs/errors.md` describes the code, not the text.
- [Two waiters unlink the same corrupt owner] → Already the dead-owner path: the loser gets ENOENT, `clearLock` returns `false`, the loop re-reads. No new state.
- [Windows: `unlinkSync` on the corrupt file while another process holds it open] → Same as the existing dead-owner unlink; not new.

## Migration Plan

No data or config migration. #1215 ships with the next engine tag; until then the CLI's own pre-spawn check keeps `E_MODEL_MISSING` for `kesha` users, and only direct `kesha-engine` callers see the old code. #1224 ships with the next CLI tag. #1223 takes effect on merge (next Sunday's run).

## Open Questions

- None blocking. Whether a lane should ever stage real Parakeet is #1223's follow-up decision, not this change.
