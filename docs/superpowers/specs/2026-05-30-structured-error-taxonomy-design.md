# Structured Error Taxonomy

Give every user-facing failure path a stable error code, emitted by the engine, surfaced to the user, recorded in Stats and diagnostic logs as the leak-free primary signal, and documented one row per code. Closes the audit items #345 item 17 (stable codes + docs) and #344 item 9 (wire codes into Stats/log sanitization so arbitrary CLI args / model URLs / sidecar stderr can't leak). Tracked by epic #462.

This is an **engine release**: it changes `rust/` and adds an engine capability (`--error-codes-json`).

## Goals

- A stable, documented code at every user-facing failure path (download, cache corrupt, unsupported platform, sidecar missing, model load, bad audio, unsupported SSML, model-not-installed, etc.).
- Codes are the **structured backstop** for sanitization: support and Stats key off the code, not a regex-redacted free-form string.
- Codes are user-visible so a user/support can quote a stable token and look it up.
- Engine is the single source of truth for engine codes; TS owns codes for failures that happen before/around the engine.

## Non-goals

- **Exit-code normalization.** Exit codes stay as-is today (0 success, 2 usage/validation, 1 runtime, 4 say-synthesis). Codes are orthogonal to exit codes and carry the granularity; remapping exit codes is a separate behavior-contract change, out of scope.
- Changing stdout output contracts (`--json`/`--toon`/plain transcript). The code travels on **stderr**.
- Localizing or rewording the human-readable messages. Wording can stay; the code is the new stable part.
- Retry/backoff behavior. `retryable` is metadata only in this iteration.

## Design

### Emit mechanism: one `error [CODE]:` line serves human + machine

On any user-facing failure, the engine prints its final stderr line as:

```
error [E_MODEL_MISSING]: voice 'ru-vosk-m02' not installed. run: kesha install --tts
```

- The **user** reads it directly (user-visible decision).
- **TS** extracts the code with an anchored regex `^error \[([A-Z0-9_]+)\]:` (multiline). The `[CODE]` token has a constrained charset (`[A-Z0-9_]+`), so extraction is unambiguous **even when the message contains a path or token**. That message is still sanitized before it reaches Stats/logs; the code never needs sanitizing.

This one line is both the human surface and the machine contract. No separate marker line, no stdout change, identical for `transcribe` / `say` / `install`.

### Rust: `CodedError` carrying a stable `ErrorCode`

New `rust/src/errors.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InputNotFound, BadAudio,
    ModelMissing, ModelDownload, CacheCorrupt, ModelLoad,
    UnsupportedPlatform, SidecarMissing, NoBackend,
    TextEmpty, TextTooLong, VoiceUnknown, SsmlInvalid, SsmlUnsupported,
    TranscribeFailed, DiarizeTimeout,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str { /* "E_MODEL_MISSING", ... */ }
    pub fn title(self) -> &'static str { /* short human title for --error-codes-json */ }
    pub fn category(self) -> Category { /* Input | Model | Platform | Tts | Transcribe | Internal */ }
    pub fn retryable(self) -> bool { /* download/timeout = true, rest = false */ }
}

/// Carries a code alongside the human message. Sits in the anyhow chain.
#[derive(Debug)]
pub struct CodedError { pub code: ErrorCode, pub message: String }
impl std::fmt::Display for CodedError { /* writes message only */ }
impl std::error::Error for CodedError {}
```

A macro replaces the relevant `anyhow::bail!` sites:

```rust
// before: anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
coded_bail!(ErrorCode::ModelMissing, "voice '{voice_id}' not installed. run: kesha install --tts");
```

`coded_bail!` constructs `CodedError` and returns `Err(anyhow::Error::new(CodedError {..}))`. Existing `.context()` chains are left in place — the `CodedError` sits in the chain and is found by downcast at the top.

Top-level handler (`main.rs`, and the `say` direct-exit path in `cli/say.rs`):

```rust
fn report(err: &anyhow::Error) -> i32 {
    let code = err.chain()
        .find_map(|e| e.downcast_ref::<CodedError>().map(|c| c.code))
        .unwrap_or(ErrorCode::Internal);
    eprintln!("error [{}]: {:#}", code.as_str(), err);  // {:#} = full chain message
    /* existing exit code logic unchanged */
}
```

Uncoded `anyhow` errors that bubble up unwrapped fall back to `E_INTERNAL` — so the contract holds even for paths not yet individually coded.

### Engine introspection: `kesha-engine --error-codes-json`

```json
[
  {"code":"E_MODEL_MISSING","title":"Model not installed","category":"model","retryable":false},
  {"code":"E_MODEL_DOWNLOAD","title":"Model download failed","category":"model","retryable":true},
  ...
]
```

Lists every engine code. Powers `kesha doctor`, makes the taxonomy introspectable, and is the cross-language source the drift test consumes.

### Code catalogue

| Code | Category | Fires when | Origin |
|------|----------|-----------|--------|
| `E_INPUT_NOT_FOUND` | input | input audio path doesn't exist / no stdin | TS + engine |
| `E_BAD_AUDIO` | input | container/decode failure (symphonia) | engine |
| `E_MODEL_MISSING` | model | required model/voice not installed | engine |
| `E_MODEL_DOWNLOAD` | model | download from HF/mirror failed | engine |
| `E_CACHE_CORRUPT` | model | cached file fails hash verify / won't load | engine |
| `E_MODEL_LOAD` | model | ONNX/session build or model load failed | engine |
| `E_UNSUPPORTED_PLATFORM` | platform | feature unsupported on this OS/arch (e.g. record off-macOS) | engine |
| `E_SIDECAR_MISSING` | platform | `say-avspeech` sidecar not found/spawnable | engine |
| `E_NO_BACKEND` | platform | binary built without onnx/coreml | engine |
| `E_TEXT_EMPTY` | tts | empty synth text | engine |
| `E_TEXT_TOO_LONG` | tts | text exceeds max chars | engine |
| `E_VOICE_UNKNOWN` | tts | unrecognized voice id | engine |
| `E_SSML_INVALID` | tts | malformed SSML / DOCTYPE / no `<speak>` root | engine |
| `E_SSML_UNSUPPORTED` | tts | SSML used where engine rejects it (e.g. AVSpeech) | engine |
| `E_TRANSCRIBE_FAILED` | transcribe | ASR pipeline failure | engine |
| `E_DIARIZE_TIMEOUT` | transcribe | diarization cold-compile/run timeout | engine |
| `E_ENGINE_SPAWN` | internal | TS failed to spawn the engine subprocess | TS |
| `E_INVALID_ARG` | input | CLI flag validation failure (exit 2 paths) | TS |
| `E_INTERNAL` | internal | uncoded/unexpected failure (catch-all) | TS + engine |

`E_INVALID_ARG` and `E_ENGINE_SPAWN` are TS-native (the engine never runs, or isn't the failing party). The existing lone Stats code `file_not_found` migrates to `E_INPUT_NOT_FOUND`.

### TS: hybrid wiring + sanitization (epic checkbox 2)

- `src/cli/main.ts:407` (`transcribe`) and `src/cli/say.ts:253` (`tts`) currently call `stats.recordError(stage, err)` with **no code**. Extract the code from engine stderr and pass it: `stats.recordError(stage, err, codeFromEngine(stderr) ?? "E_INTERNAL")`.
- New helper `src/error-codes.ts`: `extractEngineErrorCode(stderr): string | undefined` (the anchored regex) + the TS-native code constants + `KNOWN_TS_CODES` set.
- Diagnostic logs: add `error_code` to failure events (`*_failed`). Verified leak-free — `error_code` matches none of `DISALLOWED_FIELD_NAME` and the value charset `[A-Z0-9_]+` passes `SAFE_STRING_VALUE` / fails `UNSAFE_STRING_VALUE`. The code becomes the **primary** failure signal in logs; the sanitized message stays as secondary context.
- TS-native failures (`E_INVALID_ARG`, `E_ENGINE_SPAWN`, `E_INPUT_NOT_FOUND`) print `error [CODE]: <message>` in the same format so the user-facing surface is uniform across TS and engine origins.

The point of the code (per audit #344 item 9): Stats/support no longer depend on regex redaction being complete — the structured code is stable and leak-free by construction.

### Docs (epic checkbox 3)

New `docs/errors.md`: one row per code — code, category, when it fires, likely cause, how to fix, retryable. Linked from `README.md` and `docs/diagnostic-logs.md`. The page is the human registry; the drift tests keep it honest.

## Data flow

```
[leaf failure, Rust]  coded_bail!(ErrorCode::ModelMissing, "...")
   -> anyhow::Error carrying CodedError in its chain
   -> propagates up through existing .context() wrappers
   -> report(): chain-downcast -> code; eprintln "error [E_MODEL_MISSING]: <chain msg>"; exit nonzero
[TS]  spawn engine, capture stderr
   -> on nonzero exit: extractEngineErrorCode(stderr) -> "E_MODEL_MISSING" (fallback E_INTERNAL)
   -> stats.recordError(stage, err, code)              // message sanitized, code stored verbatim
   -> diagnosticSession.event("say_failed", { error_code: code })   // leak-free field
   -> user already saw the human stderr line with [E_MODEL_MISSING]
[TS-native failure]  (file not found, spawn fail, bad flag)
   -> TS owns the code -> print "error [CODE]: ..." + same recordError + diagnostic event
```

## Testing

- **Rust** (`rust/src/errors.rs` tests): `as_str()` mapping is stable and unique; `coded_bail!` produces an error whose chain-downcast yields the expected code; `report()` formats `error [CODE]:`; `--error-codes-json` emits valid JSON covering every variant.
- **Rust drift gate**: a test asserts every `ErrorCode` variant string appears in `../docs/errors.md` (reads the markdown).
- **TS** (`src/__tests__/error-codes.test.ts`): `extractEngineErrorCode` returns the code for representative engine stderr — **including messages that embed a path or token** (proves the code extracts while the message is what gets sanitized); returns `undefined` for un-coded stderr so the caller falls back to `E_INTERNAL`.
- **TS Stats test**: `recordError(stage, err, code)` persists `error_code`; sanitized message still redacts paths/URLs/JSON fields.
- **TS drift gate**: `(codes from kesha-engine --error-codes-json) ∪ KNOWN_TS_CODES == (E_ codes documented in docs/errors.md)`. Catches a code added without docs and a doc row with no code. Uses a repo-local engine build (`KESHA_ENGINE_BIN` / `rust/target/release/kesha-engine`), guarded to skip if the engine binary isn't built (like other engine-dependent TS tests).

## Release

Engine release. Bump together: `rust/Cargo.toml`, `rust/Cargo.lock` (`cargo check`), `package.json#keshaEngine.version`, `package.json#version`. No new cargo feature, so the `build-engine.yml` feature matrix is unaffected.

## Out of scope / follow-ups

- Exit-code normalization (codes are sufficient granularity now).
- `retryable` driving actual retry behavior.
- Coding internal/non-user-facing failures that never reach a CLI boundary.
