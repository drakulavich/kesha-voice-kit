# Structured Error Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every user-facing failure path a stable, documented, user-visible error code emitted by the engine and recorded as the leak-free primary signal in Stats and diagnostic logs; unify every error surface (Rust `anyhow`/`TtsError`, the Rust `say` exit path, TS engine errors, `SayError`, and the JSON `errors[].code` union) onto one taxonomy.

**Architecture:** A new `rust/src/errors.rs` defines `ErrorCode` + `CodedError` + a `coded_bail!` macro + a `.coded()` Result extension. Leaf failures attach a code; a top-level `report()` chain-walks for the code and prints `error [CODE]: <message>` to stderr. TS extracts the `[CODE]` token from engine stderr (anchored regex) and threads it into `recordError`, diagnostic `error_code` fields, `SayError.code`, and the `errors[].code` JSON output. A drift test enforces engine-codes ∪ TS-native-codes == documented codes.

**Tech Stack:** Rust (anyhow, thiserror, serde_json, nextest), Bun/TypeScript (bun:test), Markdown docs.

**Spec:** `docs/superpowers/specs/2026-05-30-structured-error-taxonomy-design.md`

**Release:** Engine release — final task bumps `rust/Cargo.toml`, `rust/Cargo.lock`, `package.json#keshaEngine.version`, `package.json#version`.

**Conventions for every Rust task:** verify with `cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --features tts`. Use `cargo nextest run`, never plain `cargo test`.

---

## Task 1: `errors.rs` foundation — `ErrorCode`, `CodedError`, `coded_bail!`, `report()`, `.coded()`

**Files:**
- Create: `rust/src/errors.rs`
- Modify: `rust/src/lib.rs:30` (add `pub mod errors;` in the alphabetical mod block)
- Modify: `rust/src/main.rs:4` (add `mod errors;` in the mod block)

- [ ] **Step 1: Write the failing test** — append to the new `rust/src/errors.rs` (write the whole file including the `#[cfg(test)]` block below in Step 3; this step is the test module):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_strings_are_stable_unique_and_prefixed() {
        let all = ErrorCode::ALL;
        let mut seen = std::collections::HashSet::new();
        for c in all {
            let s = c.as_str();
            assert!(s.starts_with("E_"), "{s} must start with E_");
            assert!(seen.insert(s), "duplicate code string {s}");
            assert!(!c.title().is_empty(), "{s} missing title");
        }
    }

    #[test]
    fn coded_bail_attaches_code_findable_in_chain() {
        fn leaf() -> anyhow::Result<()> {
            coded_bail!(ErrorCode::ModelMissing, "voice '{}' not installed", "ru-vosk-m02");
        }
        let err = leaf().unwrap_err().context("while loading voice");
        assert_eq!(code_of(&err), ErrorCode::ModelMissing);
    }

    #[test]
    fn coded_extension_snapshots_message_and_code() {
        let res: anyhow::Result<()> = Err(anyhow::anyhow!("boom"))
            .context("decode error in: /Users/alice/secret.wav")
            .coded(ErrorCode::BadAudio);
        let err = res.unwrap_err();
        assert_eq!(code_of(&err), ErrorCode::BadAudio);
        let coded = err.downcast_ref::<CodedError>().expect("is CodedError");
        assert!(coded.message.contains("decode error"));
    }

    #[test]
    fn code_of_falls_back_to_internal_for_uncoded() {
        let err = anyhow::anyhow!("plain error");
        assert_eq!(code_of(&err), ErrorCode::Internal);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust && cargo nextest run --features tts errors:: 2>&1 | tail -20`
Expected: FAIL — `errors` module / `ErrorCode` not found (compile error).

- [ ] **Step 3: Write minimal implementation** — prepend this above the test module in `rust/src/errors.rs`:

```rust
//! Stable, user-visible error codes for every user-facing failure path.
//!
//! A leaf failure attaches a code via [`coded_bail!`] or [`CodedContext::coded`].
//! The code rides in the `anyhow` chain inside a [`CodedError`]; the top-level
//! [`report`] walks the chain, prints `error [CODE]: <message>` to stderr, and
//! returns the process exit code. See
//! `docs/superpowers/specs/2026-05-30-structured-error-taxonomy-design.md`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InputNotFound,
    BadAudio,
    ModelMissing,
    ModelDownload,
    CacheCorrupt,
    ModelLoad,
    UnsupportedPlatform,
    SidecarMissing,
    NoBackend,
    TextEmpty,
    TextTooLong,
    VoiceUnknown,
    SsmlInvalid,
    SsmlUnsupported,
    TranscribeFailed,
    DiarizeTimeout,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Input,
    Model,
    Platform,
    Tts,
    Transcribe,
    Internal,
}

impl ErrorCode {
    /// Every variant, for tests and `--error-codes-json`.
    pub const ALL: [ErrorCode; 17] = [
        ErrorCode::InputNotFound,
        ErrorCode::BadAudio,
        ErrorCode::ModelMissing,
        ErrorCode::ModelDownload,
        ErrorCode::CacheCorrupt,
        ErrorCode::ModelLoad,
        ErrorCode::UnsupportedPlatform,
        ErrorCode::SidecarMissing,
        ErrorCode::NoBackend,
        ErrorCode::TextEmpty,
        ErrorCode::TextTooLong,
        ErrorCode::VoiceUnknown,
        ErrorCode::SsmlInvalid,
        ErrorCode::SsmlUnsupported,
        ErrorCode::TranscribeFailed,
        ErrorCode::DiarizeTimeout,
        ErrorCode::Internal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InputNotFound => "E_INPUT_NOT_FOUND",
            ErrorCode::BadAudio => "E_BAD_AUDIO",
            ErrorCode::ModelMissing => "E_MODEL_MISSING",
            ErrorCode::ModelDownload => "E_MODEL_DOWNLOAD",
            ErrorCode::CacheCorrupt => "E_CACHE_CORRUPT",
            ErrorCode::ModelLoad => "E_MODEL_LOAD",
            ErrorCode::UnsupportedPlatform => "E_UNSUPPORTED_PLATFORM",
            ErrorCode::SidecarMissing => "E_SIDECAR_MISSING",
            ErrorCode::NoBackend => "E_NO_BACKEND",
            ErrorCode::TextEmpty => "E_TEXT_EMPTY",
            ErrorCode::TextTooLong => "E_TEXT_TOO_LONG",
            ErrorCode::VoiceUnknown => "E_VOICE_UNKNOWN",
            ErrorCode::SsmlInvalid => "E_SSML_INVALID",
            ErrorCode::SsmlUnsupported => "E_SSML_UNSUPPORTED",
            ErrorCode::TranscribeFailed => "E_TRANSCRIBE_FAILED",
            ErrorCode::DiarizeTimeout => "E_DIARIZE_TIMEOUT",
            ErrorCode::Internal => "E_INTERNAL",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            ErrorCode::InputNotFound => "Input file not found",
            ErrorCode::BadAudio => "Unreadable or unsupported audio",
            ErrorCode::ModelMissing => "Model or voice not installed",
            ErrorCode::ModelDownload => "Model download failed",
            ErrorCode::CacheCorrupt => "Cached model failed verification",
            ErrorCode::ModelLoad => "Model failed to load",
            ErrorCode::UnsupportedPlatform => "Feature unsupported on this platform",
            ErrorCode::SidecarMissing => "Helper sidecar missing or failed",
            ErrorCode::NoBackend => "No ASR backend compiled in",
            ErrorCode::TextEmpty => "Empty synthesis text",
            ErrorCode::TextTooLong => "Synthesis text too long",
            ErrorCode::VoiceUnknown => "Unknown voice id",
            ErrorCode::SsmlInvalid => "Malformed SSML",
            ErrorCode::SsmlUnsupported => "SSML not supported for this engine",
            ErrorCode::TranscribeFailed => "Transcription failed",
            ErrorCode::DiarizeTimeout => "Speaker diarization timed out",
            ErrorCode::Internal => "Unexpected internal error",
        }
    }

    pub fn category(self) -> Category {
        match self {
            ErrorCode::InputNotFound | ErrorCode::BadAudio => Category::Input,
            ErrorCode::ModelMissing
            | ErrorCode::ModelDownload
            | ErrorCode::CacheCorrupt
            | ErrorCode::ModelLoad => Category::Model,
            ErrorCode::UnsupportedPlatform
            | ErrorCode::SidecarMissing
            | ErrorCode::NoBackend => Category::Platform,
            ErrorCode::TextEmpty
            | ErrorCode::TextTooLong
            | ErrorCode::VoiceUnknown
            | ErrorCode::SsmlInvalid
            | ErrorCode::SsmlUnsupported => Category::Tts,
            ErrorCode::TranscribeFailed | ErrorCode::DiarizeTimeout => Category::Transcribe,
            ErrorCode::Internal => Category::Internal,
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::ModelDownload | ErrorCode::DiarizeTimeout
        )
    }
}

/// An error carrying a stable [`ErrorCode`] plus a human message. Sits as a
/// leaf in the `anyhow` chain so [`code_of`] can recover the code.
#[derive(Debug)]
pub struct CodedError {
    pub code: ErrorCode,
    pub message: String,
}

impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodedError {}

/// Construct and return a coded error. Drop-in for `anyhow::bail!`.
#[macro_export]
macro_rules! coded_bail {
    ($code:expr, $($arg:tt)*) => {
        return ::core::result::Result::Err(::anyhow::Error::new($crate::errors::CodedError {
            code: $code,
            message: ::std::format!($($arg)*),
        }))
    };
}

/// Attach a code to a `Result`, snapshotting the existing chain message.
pub trait CodedContext<T> {
    fn coded(self, code: ErrorCode) -> anyhow::Result<T>;
}

impl<T, E> CodedContext<T> for Result<T, E>
where
    E: Into<anyhow::Error>,
{
    fn coded(self, code: ErrorCode) -> anyhow::Result<T> {
        self.map_err(|e| {
            let e: anyhow::Error = e.into();
            anyhow::Error::new(CodedError {
                code,
                message: format!("{e:#}"),
            })
        })
    }
}

/// Recover the code from anywhere in the chain; `Internal` if none.
pub fn code_of(err: &anyhow::Error) -> ErrorCode {
    err.chain()
        .find_map(|e| e.downcast_ref::<CodedError>().map(|c| c.code))
        .unwrap_or(ErrorCode::Internal)
}

/// Print `error [CODE]: <message>` to stderr and return the process exit code.
/// Exit code stays 1 (runtime failure) — unchanged from prior behavior.
pub fn report(err: &anyhow::Error) -> i32 {
    let code = code_of(err);
    eprintln!("error [{}]: {:#}", code.as_str(), err);
    1
}
```

- [ ] **Step 4: Register the module** — in `rust/src/lib.rs`, add `pub mod errors;` (alphabetical, between `debug` and `fluid_stdout`); in `rust/src/main.rs`, add `mod errors;` in the same position.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd rust && cargo nextest run --features tts errors::`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add rust/src/errors.rs rust/src/lib.rs rust/src/main.rs
git commit -m "feat(engine): error-code taxonomy foundation (errors.rs)"
```

---

## Task 2: Top-level reporting — `main.rs` prints `error [CODE]:`

The `say` arm already `process::exit`s with its own code (wired in Task 10). Every other command propagates `anyhow::Result` to `fn main`. Restructure so a propagated error routes through `errors::report`.

**Files:**
- Modify: `rust/src/main.rs:167-260` (`fn main`)
- Test: `rust/tests/error_codes_cli.rs` (create)

- [ ] **Step 1: Write the failing test** — create `rust/tests/error_codes_cli.rs`:

```rust
//! CLI-level assertions that failures print `error [CODE]:` on stderr.
use std::process::Command;

fn engine_bin() -> String {
    std::env::var("CARGO_BIN_EXE_kesha-engine")
        .unwrap_or_else(|_| "target/release/kesha-engine".to_string())
}

#[test]
fn transcribe_missing_file_prints_input_not_found_code() {
    let out = Command::new(engine_bin())
        .args(["transcribe", "/nonexistent/path/audio.wav"])
        .output()
        .expect("spawn engine");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "should exit nonzero");
    assert!(
        stderr.contains("error [E_"),
        "stderr should carry a coded line, got: {stderr}"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust && cargo nextest run --features tts --test error_codes_cli`
Expected: FAIL — stderr is the old uncoded `Error: ...` Display (no `error [E_`). (The transcribe-missing-file path is coded in Task 6/9; this test passes once main.rs routing + that site land. If it fails only because the path isn't coded yet, it still exercises the `E_INTERNAL` fallback — so it should pass as soon as main.rs routing lands, because `code_of` falls back to `E_INTERNAL` and prints `error [E_INTERNAL]:`.)

- [ ] **Step 3: Write minimal implementation** — change `fn main() -> Result<()>` into a thin wrapper plus `run_command`. Replace the signature and the trailing `Ok(())` so the body becomes:

```rust
fn main() {
    debug::init();
    let cli = Cli::parse();

    if cli.capabilities_json {
        let caps = capabilities::get_capabilities();
        match serde_json::to_string(&caps) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                let err = anyhow::Error::new(e);
                std::process::exit(errors::report(&err));
            }
        }
        return;
    }

    if let Err(err) = run_command(cli.command) {
        std::process::exit(errors::report(&err));
    }
}

fn run_command(command: Option<Commands>) -> Result<()> {
    match command {
        // ... existing match arms moved here verbatim, including the
        // `Some(Commands::Say { .. }) => { std::process::exit(cli::say::run(..)); }`
        // arm (it diverges, so it never returns to `run_command`) ...
        None => {
            eprintln!("Usage: kesha-engine <command>");
            eprintln!("Run --help for usage information");
            std::process::exit(1);
        }
    }
    Ok(())
}
```

Move the existing `match cli.command { ... }` arms into `run_command` unchanged. The `Say` arm keeps its `std::process::exit(...)`.

- [ ] **Step 4: Build the release binary the integration test needs, then run**

Run: `cd rust && cargo build --release --features tts && cargo nextest run --features tts --test error_codes_cli`
Expected: PASS — stderr contains `error [E_INTERNAL]:` (input-not-found becomes `E_INPUT_NOT_FOUND` after Task 9).

- [ ] **Step 5: Commit**

```bash
git add rust/src/main.rs rust/tests/error_codes_cli.rs
git commit -m "feat(engine): route command failures through coded report()"
```

---

## Task 3: `kesha-engine --error-codes-json`

**Files:**
- Modify: `rust/src/main.rs` (add `--error-codes-json` flag to `Cli` struct + handle it next to `capabilities_json`)
- Modify: `rust/src/errors.rs` (add `error_codes_json()` producing the JSON string)
- Test: `rust/src/errors.rs` test module

- [ ] **Step 1: Write the failing test** — add to `rust/src/errors.rs` tests:

```rust
    #[test]
    fn error_codes_json_covers_all_variants() {
        let json = error_codes_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), ErrorCode::ALL.len());
        for c in ErrorCode::ALL {
            assert!(
                arr.iter().any(|e| e["code"] == c.as_str()),
                "{} missing from --error-codes-json",
                c.as_str()
            );
        }
        // shape check on one entry
        let model_missing = arr
            .iter()
            .find(|e| e["code"] == "E_MODEL_MISSING")
            .unwrap();
        assert_eq!(model_missing["category"], "model");
        assert_eq!(model_missing["retryable"], false);
        assert!(model_missing["title"].is_string());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust && cargo nextest run --features tts errors::error_codes_json`
Expected: FAIL — `error_codes_json` not found.

- [ ] **Step 3: Write minimal implementation** — add to `rust/src/errors.rs` (above the test module):

```rust
#[derive(Serialize)]
struct CodeEntry {
    code: &'static str,
    title: &'static str,
    category: Category,
    retryable: bool,
}

/// JSON array of every error code, for `--error-codes-json`, docs drift tests,
/// and `kesha doctor`.
pub fn error_codes_json() -> String {
    let entries: Vec<CodeEntry> = ErrorCode::ALL
        .iter()
        .map(|&c| CodeEntry {
            code: c.as_str(),
            title: c.title(),
            category: c.category(),
            retryable: c.retryable(),
        })
        .collect();
    serde_json::to_string(&entries).expect("error-codes serialize")
}
```

In `rust/src/main.rs`, add the flag to the `Cli` struct next to `capabilities_json` (match its `#[arg(...)]` style):

```rust
    /// Print the error-code taxonomy as JSON and exit.
    #[arg(long = "error-codes-json")]
    error_codes_json: bool,
```

And handle it in `fn main`, right after the `capabilities_json` block:

```rust
    if cli.error_codes_json {
        println!("{}", errors::error_codes_json());
        return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rust && cargo nextest run --features tts errors:: && cargo build --release --features tts && ./target/release/kesha-engine --error-codes-json | jq 'length'`
Expected: tests PASS; jq prints `17`.

- [ ] **Step 5: Commit**

```bash
git add rust/src/errors.rs rust/src/main.rs
git commit -m "feat(engine): kesha-engine --error-codes-json introspection"
```

---

## Task 4: Wire TTS voice/model-missing sites (`voices.rs`)

**Files:**
- Modify: `rust/src/tts/voices.rs:151,156,184,186` (the four `anyhow::bail!` sites seen in the resolver)

- [ ] **Step 1: Add the import** at the top of `rust/src/tts/voices.rs` (after existing `use` lines):

```rust
use crate::coded_bail;
use crate::errors::ErrorCode;
```

- [ ] **Step 2: Replace the four bail sites** (exact substitutions):

Kokoro voice missing:
```rust
// before:
anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
// after:
coded_bail!(ErrorCode::ModelMissing, "voice '{voice_id}' not installed. run: kesha install --tts");
```

Kokoro model missing:
```rust
// before:
anyhow::bail!(
    "kokoro model not installed at {}. run: kesha install --tts",
    model_path.display()
);
// after:
coded_bail!(
    ErrorCode::ModelMissing,
    "kokoro model not installed at {}. run: kesha install --tts",
    model_path.display()
);
```

Unknown Russian voice (the `_ =>` arm):
```rust
// before:
_ => anyhow::bail!(
    "unknown Russian voice '{voice_id}'. valid: ru-vosk-f01, ru-vosk-f02, \
     ru-vosk-f03, ru-vosk-m01, ru-vosk-m02"
),
// after:
_ => coded_bail!(
    ErrorCode::VoiceUnknown,
    "unknown Russian voice '{voice_id}'. valid: ru-vosk-f01, ru-vosk-f02, \
     ru-vosk-f03, ru-vosk-m01, ru-vosk-m02"
),
```

Vosk model missing:
```rust
// before:
anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
// after:
coded_bail!(ErrorCode::ModelMissing, "voice '{voice_id}' not installed. run: kesha install --tts");
```

- [ ] **Step 3: Verify**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts voices`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add rust/src/tts/voices.rs
git commit -m "feat(engine): code voice/model-missing failures (E_MODEL_MISSING/E_VOICE_UNKNOWN)"
```

---

## Task 5: Wire SSML sites (`ssml/mod.rs`)

**Files:**
- Modify: `rust/src/tts/ssml/mod.rs:43,46,57,67+` (the `anyhow::bail!` sites in `parse`)

- [ ] **Step 1: Add imports** at the top of `rust/src/tts/ssml/mod.rs`:

```rust
use crate::coded_bail;
use crate::errors::ErrorCode;
```

- [ ] **Step 2: Replace each `anyhow::bail!` in `parse` with `coded_bail!(ErrorCode::SsmlInvalid, ...)`** keeping the message args identical. Sites: empty input, missing `<speak>` root, DOCTYPE rejection, relative-percent rate. Example:

```rust
// before:
anyhow::bail!("SSML input is empty");
// after:
coded_bail!(ErrorCode::SsmlInvalid, "SSML input is empty");
```

Apply the same transform to the `<speak>`-root, DOCTYPE, and relative-rate bails (each keeps its existing format string + args).

- [ ] **Step 3: Verify**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts ssml`
Expected: PASS (existing `rust/tests/ssml_integration.rs` still green; messages unchanged).

- [ ] **Step 4: Commit**

```bash
git add rust/src/tts/ssml/mod.rs
git commit -m "feat(engine): code SSML parse failures (E_SSML_INVALID)"
```

---

## Task 6: Wire audio decode (`audio.rs`)

**Files:**
- Modify: `rust/src/audio.rs:105,120` (the two `.with_context(|| format!("decode error in: {path}"))` sites)

- [ ] **Step 1: Add import** at the top of `rust/src/audio.rs`:

```rust
use crate::errors::{CodedContext, ErrorCode};
```

- [ ] **Step 2: Append `.coded(ErrorCode::BadAudio)` after each decode-error context** (both the `format.next_packet()` and `decoder.decode()` arms):

```rust
// before:
Err(e) => return Err(e).with_context(|| format!("decode error in: {path}")),
// after:
Err(e) => {
    return Err(e)
        .with_context(|| format!("decode error in: {path}"))
        .coded(ErrorCode::BadAudio)
}
```

Apply identically to both sites (lines ~105 and ~120).

- [ ] **Step 3: Verify**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts audio`
Expected: PASS (existing `rust/tests/audio_format.rs` still green).

- [ ] **Step 4: Commit**

```bash
git add rust/src/audio.rs
git commit -m "feat(engine): code audio decode failures (E_BAD_AUDIO)"
```

---

## Task 7: Wire model download + cache-corrupt (`models.rs`)

**Files:**
- Modify: `rust/src/models.rs:1083` (sha256-mismatch `anyhow::bail!` → `E_CACHE_CORRUPT`)
- Modify: `rust/src/models.rs` download-request error in `download_verified` (the HTTP GET error path → `E_MODEL_DOWNLOAD`)

- [ ] **Step 1: Add imports** at the top of `rust/src/models.rs`:

```rust
use crate::coded_bail;
use crate::errors::{CodedContext, ErrorCode};
```

- [ ] **Step 2: Code the sha256 mismatch** (cache corrupt):

```rust
// before:
anyhow::bail!(
    "sha256 mismatch for {}: expected {} got {}",
    f.rel_path,
    f.sha256.get(..12).unwrap_or(f.sha256),
    actual.get(..12).unwrap_or(&actual)
);
// after:
coded_bail!(
    ErrorCode::CacheCorrupt,
    "sha256 mismatch for {}: expected {} got {}",
    f.rel_path,
    f.sha256.get(..12).unwrap_or(f.sha256),
    actual.get(..12).unwrap_or(&actual)
);
```

- [ ] **Step 3: Code the download/GET failure.** In `download_verified`, find the HTTP request/response error handling (grep `Run: grep -n "GET\|ureq\|reqwest\|\.call()\|\.send()\|response\|status()" rust/src/models.rs`). Wherever the network fetch error is `?`-propagated or `.context()`-wrapped, append `.coded(ErrorCode::ModelDownload)`. Example shape (adapt to the actual call):

```rust
// before:
let resp = agent.get(url).call().with_context(|| format!("GET {url}"))?;
// after:
let resp = agent
    .get(url)
    .call()
    .with_context(|| format!("GET {url}"))
    .coded(ErrorCode::ModelDownload)?;
```

If a non-2xx status is turned into an error separately, code that site too with `ErrorCode::ModelDownload`.

- [ ] **Step 4: Verify**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts models`
Expected: PASS (`models::manifest_tests` still green).

- [ ] **Step 5: Commit**

```bash
git add rust/src/models.rs
git commit -m "feat(engine): code download + cache-corrupt failures (E_MODEL_DOWNLOAD/E_CACHE_CORRUPT)"
```

---

## Task 8: Wire ONNX cache-load (`backend/onnx.rs`)

**Files:**
- Modify: `rust/src/backend/onnx.rs:33,38,43,48` (the four `.context("Failed to load ... — run install first")` sites)

- [ ] **Step 1: Add import** at the top of `rust/src/backend/onnx.rs`:

```rust
use crate::errors::{CodedContext, ErrorCode};
```

- [ ] **Step 2: Append `.coded(ErrorCode::ModelLoad)` to each model-load context** (the `commit_from_file(...).context("Failed to load ...")` chains and the `load_vocab(...).context(...)`). Example:

```rust
// before:
.commit_from_file(model_path.join("nemo128.onnx"))
.context("Failed to load nemo128.onnx — run `kesha-engine install` first")?;
// after:
.commit_from_file(model_path.join("nemo128.onnx"))
.context("Failed to load nemo128.onnx — run `kesha-engine install` first")
.coded(ErrorCode::ModelLoad)?;
```

Apply to nemo128, encoder, decoder_joint, and vocab. The "Failed to create … session builder" `.context()` lines may keep `ErrorCode::ModelLoad` too — append `.coded(ErrorCode::ModelLoad)` for consistency.

- [ ] **Step 3: Verify**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features onnx -- -D warnings && cargo nextest run --features onnx onnx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add rust/src/backend/onnx.rs
git commit -m "feat(engine): code ONNX model-load failures (E_MODEL_LOAD)"
```

---

## Task 9: Wire platform / sidecar / backend / lang-id / diarize

**Files:**
- Modify: `rust/src/record.rs:50` (unsupported platform)
- Modify: `rust/src/tts/avspeech.rs:75` (sidecar)
- Modify: `rust/src/backend/mod.rs:28` (no backend)
- Modify: `rust/src/lang_id.rs:18` (lang-id model missing)
- Modify: `rust/src/transcribe/diarize.rs:163,166` (diarize timeout + worker death)
- Modify: `rust/src/cli/transcribe.rs` input-not-found path (see Step 6)

- [ ] **Step 1: record.rs** — add `use crate::coded_bail; use crate::errors::ErrorCode;`, then:

```rust
// before:
bail!("microphone recording is currently supported on macOS only");
// after:
coded_bail!(ErrorCode::UnsupportedPlatform, "microphone recording is currently supported on macOS only");
```

(Remove the now-unused `bail` import if clippy flags it.)

- [ ] **Step 2: avspeech.rs** — add imports, then:

```rust
// before:
anyhow::bail!(
    "avspeech helper exited {}: {}",
    output.status,
    String::from_utf8_lossy(&output.stderr).trim()
);
// after:
coded_bail!(
    ErrorCode::SidecarMissing,
    "avspeech helper exited {}: {}",
    output.status,
    String::from_utf8_lossy(&output.stderr).trim()
);
```

Also code the sidecar-not-found/spawn error in `avspeech.rs` (grep `Run: grep -n "bail!\|context\|spawn\|helper_path" rust/src/tts/avspeech.rs`) with `ErrorCode::SidecarMissing`.

- [ ] **Step 3: backend/mod.rs** — add imports, then:

```rust
// before:
anyhow::bail!("No backend available — build with --features onnx or coreml")
// after:
coded_bail!(ErrorCode::NoBackend, "No backend available — build with --features onnx or coreml")
```

- [ ] **Step 4: lang_id.rs** — add imports, then:

```rust
// before:
anyhow::bail!("Lang-ID model not installed. Run: kesha install");
// after:
coded_bail!(ErrorCode::ModelMissing, "Lang-ID model not installed. Run: kesha install");
```

Also append `.coded(ErrorCode::ModelLoad)` to the two `.context("failed to create lang-id session builder")` / `.context("failed to load lang-id model")` sites.

- [ ] **Step 5: diarize.rs** — add imports, then:

```rust
// before:
Err(mpsc::RecvTimeoutError::Timeout) => {
    bail!("{}", diarize_timeout_error(timeout, audio_secs))
}
Err(mpsc::RecvTimeoutError::Disconnected) => {
    bail!("speaker diarization worker terminated unexpectedly")
}
// after:
Err(mpsc::RecvTimeoutError::Timeout) => {
    coded_bail!(ErrorCode::DiarizeTimeout, "{}", diarize_timeout_error(timeout, audio_secs))
}
Err(mpsc::RecvTimeoutError::Disconnected) => {
    coded_bail!(ErrorCode::Internal, "speaker diarization worker terminated unexpectedly")
}
```

- [ ] **Step 6: input-not-found** — in `rust/src/cli/transcribe.rs`, find where a missing input path is rejected (grep `Run: grep -n "exists\|not found\|bail\|context" rust/src/cli/transcribe.rs`). Code it `coded_bail!(ErrorCode::InputNotFound, ...)`. If the engine never checks existence (TS checks first), instead ensure `audio::ensure_audio_track`/decode failure carries `E_BAD_AUDIO` (Task 6) and leave input-existence to TS (`E_INPUT_NOT_FOUND`, Task 13). Document which path owns it in the commit message.

- [ ] **Step 7: Verify (both feature sets — backend module changed)**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo check --features coreml --no-default-features && cargo nextest run --features tts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add rust/src/record.rs rust/src/tts/avspeech.rs rust/src/backend/mod.rs rust/src/lang_id.rs rust/src/transcribe/diarize.rs rust/src/cli/transcribe.rs
git commit -m "feat(engine): code platform/sidecar/backend/lang-id/diarize failures"
```

---

## Task 10: `say` exit path — `TtsError::code()` + `error [CODE]:` formatting

The `say` path (`cli/say.rs`) returns `i32`, prints `error: {msg}`, and maps `TtsError` → exit code via `exit_code_for_tts_err`. Make it print `error [CODE]: {msg}`, keep exit codes unchanged.

**Files:**
- Modify: `rust/src/tts/mod.rs:42-49` (`TtsError` — add `code()` method)
- Modify: `rust/src/cli/say.rs` (all `eprintln!("error: ...")` sites → `error [CODE]:`)
- Test: `rust/src/tts/mod.rs` test module (or `rust/tests/tts_e2e.rs`)

- [ ] **Step 1: Write the failing test** — add to `rust/src/tts/mod.rs` (new `#[cfg(test)]` mod or existing):

```rust
#[cfg(test)]
mod code_tests {
    use super::*;
    use crate::errors::ErrorCode;

    #[test]
    fn tts_error_maps_to_codes() {
        assert_eq!(TtsError::EmptyText.code(), ErrorCode::TextEmpty);
        assert_eq!(
            TtsError::TextTooLong { max: 5000, actual: 6000 }.code(),
            ErrorCode::TextTooLong
        );
        assert_eq!(
            TtsError::SynthesisFailed("x".into()).code(),
            ErrorCode::Internal
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust && cargo nextest run --features tts code_tests`
Expected: FAIL — `TtsError::code` not found.

- [ ] **Step 3: Implement `TtsError::code()`** — add to `rust/src/tts/mod.rs` after the enum:

```rust
impl TtsError {
    /// Stable taxonomy code for this synthesis failure.
    pub fn code(&self) -> crate::errors::ErrorCode {
        use crate::errors::ErrorCode;
        match self {
            TtsError::EmptyText => ErrorCode::TextEmpty,
            TtsError::TextTooLong { .. } => ErrorCode::TextTooLong,
            TtsError::SynthesisFailed(_) => ErrorCode::Internal,
        }
    }
}
```

- [ ] **Step 4: Update `cli/say.rs` printing.** For each error print, include the code. The two kinds:

  - **Anyhow errors** (resolver / synth that returns `anyhow::Error`): use `crate::errors::code_of(&err)`:
    ```rust
    // before:
    eprintln!("error: {err}");
    return exit_code_for_tts_err(&err);
    // after (where `err` is anyhow::Error):
    eprintln!("error [{}]: {err:#}", crate::errors::code_of(&err).as_str());
    return exit_code_for_tts_err_anyhow(&err);
    ```
    where the resolver path that exits 1 keeps exit 1. If the existing code matches on `TtsError`, use `e.code().as_str()` instead.

  - **`TtsError` directly**: 
    ```rust
    // before:
    eprintln!("error: {err}");
    return exit_code_for_tts_err(&err);
    // after:
    eprintln!("error [{}]: {err}", err.code().as_str());
    return exit_code_for_tts_err(&err);
    ```

  - **String validation errors** (`Err(msg: String)` at say.rs:176, stdin-read at 187, write-fail at 293):
    ```rust
    // before:
    eprintln!("error: {msg}");
    // after:
    eprintln!("error [{}]: {msg}", crate::errors::ErrorCode::InvalidArg.as_str());
    ```
    BUT `InvalidArg` is a TS-native code (not in the engine enum). For the engine's own validation/stdin/write prints, use the closest engine code: validation → reuse `E_INVALID_ARG`? Since the engine enum has no `InvalidArg`, add it is out of scope (it's TS-native by design). Instead the engine prints these as `E_INTERNAL` for stdin/write failures, and for argument validation the engine prints `error [E_INVALID_ARG]: ...` by using a literal string (these engine-side arg errors are rare; the user-facing arg validation happens in TS). Use a literal: `eprintln!("error [E_INVALID_ARG]: {msg}");` for the say arg-validation print, and `eprintln!("error [E_INTERNAL]: ...")` for stdin/write IO failures. Keep exit codes exactly as today.

- [ ] **Step 5: Run tests + build**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts code_tests && cargo build --release --features tts`
Expected: PASS.

- [ ] **Step 6: Manual smoke** — confirm the coded line:

Run: `cd rust && echo "" | ./target/release/kesha-engine say --voice en-am_michael 2>&1 | head -1`
Expected: `error [E_TEXT_EMPTY]: text is empty` (or the resolver's `E_MODEL_MISSING` if TTS models aren't installed — either is a coded line).

- [ ] **Step 7: Commit**

```bash
git add rust/src/tts/mod.rs rust/src/cli/say.rs
git commit -m "feat(engine): emit error [CODE]: on the say exit path"
```

---

## Task 11: Rust docs-drift gate

**Files:**
- Test: `rust/tests/error_codes_docs.rs` (create)
- (Depends on `docs/errors.md` from Task 14 — order Task 14 before this, or let it fail until docs land.)

- [ ] **Step 1: Write the test**:

```rust
//! Every engine ErrorCode must be documented in docs/errors.md.
use kesha_engine::errors::ErrorCode;

#[test]
fn every_code_is_documented() {
    let doc = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/errors.md"))
        .expect("read docs/errors.md");
    for c in ErrorCode::ALL {
        assert!(
            doc.contains(c.as_str()),
            "{} is not documented in docs/errors.md",
            c.as_str()
        );
    }
}
```

- [ ] **Step 2: Run (after Task 14)**

Run: `cd rust && cargo nextest run --features tts --test error_codes_docs`
Expected: PASS once `docs/errors.md` lists every code.

- [ ] **Step 3: Commit**

```bash
git add rust/tests/error_codes_docs.rs
git commit -m "test(engine): drift gate — every ErrorCode documented"
```

---

## Task 12: TS `error-codes.ts` — extraction + TS-native constants

**Files:**
- Create: `src/error-codes.ts`
- Test: `src/__tests__/error-codes.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `src/__tests__/error-codes.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { extractEngineErrorCode, TS_NATIVE_CODES, KNOWN_TS_CODES } from "../error-codes";

describe("extractEngineErrorCode", () => {
  test("extracts the code from a coded engine stderr line", () => {
    const stderr = "error [E_MODEL_MISSING]: voice 'ru-vosk-m02' not installed. run: kesha install --tts";
    expect(extractEngineErrorCode(stderr)).toBe("E_MODEL_MISSING");
  });

  test("extracts even when the message embeds a path or token", () => {
    const stderr = "warning: foo\nerror [E_BAD_AUDIO]: decode error in: /Users/alice/secret-token-abc.wav";
    expect(extractEngineErrorCode(stderr)).toBe("E_BAD_AUDIO");
  });

  test("returns undefined for an uncoded stderr so caller can fall back", () => {
    expect(extractEngineErrorCode("Error: something went wrong")).toBeUndefined();
  });

  test("TS-native codes are exposed and included in KNOWN_TS_CODES", () => {
    expect(TS_NATIVE_CODES.INPUT_NOT_FOUND).toBe("E_INPUT_NOT_FOUND");
    expect(TS_NATIVE_CODES.ENGINE_SPAWN).toBe("E_ENGINE_SPAWN");
    expect(TS_NATIVE_CODES.INVALID_ARG).toBe("E_INVALID_ARG");
    expect(KNOWN_TS_CODES.has("E_INTERNAL")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/error-codes.test.ts`
Expected: FAIL — module `../error-codes` not found.

- [ ] **Step 3: Write implementation** — create `src/error-codes.ts`:

```typescript
/**
 * Error-code taxonomy bridge. The engine is the source of truth for engine
 * codes (see `kesha-engine --error-codes-json`); these are the codes that
 * originate in TS, before/around the engine. See
 * `docs/superpowers/specs/2026-05-30-structured-error-taxonomy-design.md`.
 */

/** Matches the engine's `error [CODE]:` line; CODE charset is constrained. */
const ENGINE_CODE_RE = /^error \[([A-Z0-9_]+)\]:/m;

/** Extract the engine error code from captured stderr, if present. */
export function extractEngineErrorCode(stderr: string): string | undefined {
  const m = stderr.match(ENGINE_CODE_RE);
  return m ? m[1] : undefined;
}

/** Codes that originate in TS (engine never ran, or isn't the failing party). */
export const TS_NATIVE_CODES = {
  INPUT_NOT_FOUND: "E_INPUT_NOT_FOUND",
  ENGINE_SPAWN: "E_ENGINE_SPAWN",
  INVALID_ARG: "E_INVALID_ARG",
  INTERNAL: "E_INTERNAL",
} as const;

export type TsNativeCode = (typeof TS_NATIVE_CODES)[keyof typeof TS_NATIVE_CODES];

/** The full set of TS-native codes, for the drift test. */
export const KNOWN_TS_CODES: ReadonlySet<string> = new Set(Object.values(TS_NATIVE_CODES));

/** Resolve a code from engine stderr, falling back to E_INTERNAL. */
export function engineErrorCode(stderr: string): string {
  return extractEngineErrorCode(stderr) ?? TS_NATIVE_CODES.INTERNAL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/error-codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/error-codes.ts src/__tests__/error-codes.test.ts
git commit -m "feat(cli): error-code extraction + TS-native code constants"
```

---

## Task 13: Unify TS error surfaces — `recordError`, diagnostic `error_code`, `SayError`, `errors[].code`

**Files:**
- Modify: `src/types.ts:22` (`errors[].code` union)
- Modify: `src/synth.ts:95-121` (`SayError` carries `code`)
- Modify: `src/cli/main.ts:304,306,407,414` (transcribe recordError + diagnostic + errors[].code)
- Modify: `src/cli/say.ts:253-262` (tts recordError + diagnostic)
- Test: `src/__tests__/stats-error-codes.test.ts` (create)

- [ ] **Step 1: Widen the `errors[].code` union** in `src/types.ts:22`:

```typescript
// before:
  code: "file_not_found" | "transcribe_failed";
// after:
  code: "E_INPUT_NOT_FOUND" | "E_TRANSCRIBE_FAILED" | "E_BAD_AUDIO" | "E_INTERNAL";
```

- [ ] **Step 2: Add `code` to `SayError`** in `src/synth.ts:95`. Update the constructor and the three throw sites:

```typescript
// constructor — add a code field:
export class SayError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
    readonly code: string = "E_INTERNAL",
  ) {
    super(message);
    this.name = "SayError";
  }
}

// throw sites:
//   text empty  -> new SayError("text is empty", 2, "", "E_TEXT_EMPTY")
//   too long    -> new SayError(`text exceeds ${MAX_TEXT_CHARS} chars (${chars})`, 5, "", "E_TEXT_TOO_LONG")
//   engine fail -> new SayError(msg, exitCode, stderr, engineErrorCode(stderr))
```

Import at the top of `src/synth.ts`: `import { engineErrorCode, TS_NATIVE_CODES } from "./error-codes";` and use `engineErrorCode(stderr)` for the engine-failure throw (the one that carries real engine stderr).

- [ ] **Step 3: Wire transcribe in `src/cli/main.ts`.** Imports: `import { extractEngineErrorCode, TS_NATIVE_CODES } from "../error-codes";`

File-not-found site (main.ts:304-306):
```typescript
// before:
stats.recordError("input", new Error("File not found"), "file_not_found");
diagnosticLog.event("input.missing", { command: "transcribe" });
errors.push({ file, code: "file_not_found", message: "File not found" });
// after:
stats.recordError("input", new Error("File not found"), TS_NATIVE_CODES.INPUT_NOT_FOUND);
diagnosticLog.event("input.missing", { command: "transcribe", error_code: TS_NATIVE_CODES.INPUT_NOT_FOUND });
errors.push({ file, code: TS_NATIVE_CODES.INPUT_NOT_FOUND, message: "File not found" });
```

Transcribe-failure catch (main.ts:407-414):
```typescript
// before:
stats.recordError("transcribe", err);
diagnosticLog.event("engine.exit", {
  command: "transcribe",
  status: "failed",
  errorKind: "transcribe_failed",
});
const message = err instanceof Error ? err.message : String(err);
errors.push({ file, code: "transcribe_failed", message });
// after:
const stderrText = err instanceof Error ? err.message : String(err);
const code = extractEngineErrorCode(stderrText) ?? "E_TRANSCRIBE_FAILED";
stats.recordError("transcribe", err, code);
diagnosticLog.event("engine.exit", {
  command: "transcribe",
  status: "failed",
  errorKind: "transcribe_failed",
  error_code: code,
});
const message = stderrText;
errors.push({ file, code: code as ImportedErrorCodeType, message });
```

(Use the `code` value directly; the `errors[].code` type now includes these. If TS complains about the union, cast through the widened `code` field type or set the union to `string` if simpler — keep it the explicit union above for safety.)

- [ ] **Step 4: Wire say in `src/cli/say.ts:253-262`:**

```typescript
// before:
stats.recordError("tts", err);
stats.finish("failed", 1);
diagnosticLog.event("command.finish", {
  command: "say",
  status: "failed",
  errorKind: err instanceof SayError ? "say_error" : "error",
  exitCode: err instanceof SayError ? err.exitCode : 4,
});
// after:
const code = err instanceof SayError ? err.code : "E_INTERNAL";
stats.recordError("tts", err, code);
stats.finish("failed", 1);
diagnosticLog.event("command.finish", {
  command: "say",
  status: "failed",
  errorKind: err instanceof SayError ? "say_error" : "error",
  exitCode: err instanceof SayError ? err.exitCode : 4,
  error_code: code,
});
```

- [ ] **Step 5: Write the stats-code test** — create `src/__tests__/stats-error-codes.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { SayError } from "../synth";

describe("SayError carries a taxonomy code", () => {
  test("pre-check throws carry text codes", () => {
    const e = new SayError("text is empty", 2, "", "E_TEXT_EMPTY");
    expect(e.code).toBe("E_TEXT_EMPTY");
    expect(e.exitCode).toBe(2);
  });

  test("defaults to E_INTERNAL when unspecified", () => {
    const e = new SayError("boom", 4, "");
    expect(e.code).toBe("E_INTERNAL");
  });
});
```

- [ ] **Step 6: Verify**

Run: `bun test src/__tests__/error-codes.test.ts src/__tests__/stats-error-codes.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/synth.ts src/cli/main.ts src/cli/say.ts src/__tests__/stats-error-codes.test.ts
git commit -m "feat(cli): unify TS error surfaces onto the taxonomy"
```

---

## Task 14: `docs/errors.md` + cross-links

**Files:**
- Create: `docs/errors.md`
- Modify: `README.md` (add a link under diagnostics/troubleshooting)
- Modify: `docs/diagnostic-logs.md` (link the error-codes page)

- [ ] **Step 1: Write `docs/errors.md`** — one row per code (all 19: 17 engine + `E_ENGINE_SPAWN`, `E_INVALID_ARG`). Header + table:

```markdown
# Error Codes

Every user-facing failure prints a stable code on stderr:

```
error [E_MODEL_MISSING]: voice 'ru-vosk-m02' not installed. run: kesha install --tts
```

The code is stable across releases; quote it in bug reports. Engine codes are
introspectable via `kesha-engine --error-codes-json`. Codes are recorded
(leak-free) in Stats and diagnostic logs; the human message may contain a path
and is sanitized before storage.

| Code | Category | Retryable | When it fires | How to fix |
|------|----------|-----------|---------------|------------|
| `E_INPUT_NOT_FOUND` | input | no | The input audio path doesn't exist (or no stdin). | Check the path; pass a readable file. |
| `E_BAD_AUDIO` | input | no | The audio container/codec couldn't be decoded. | Re-export to wav/ogg/mp3; verify the file isn't truncated. |
| `E_MODEL_MISSING` | model | no | A required model or voice isn't installed. | `kesha install` / `kesha install --tts`. |
| `E_MODEL_DOWNLOAD` | model | yes | A model download failed (network/mirror). | Retry; check connectivity / `KESHA_MODEL_MIRROR`. |
| `E_CACHE_CORRUPT` | model | no | A cached model failed SHA-256 verification. | `kesha install --no-cache` to re-fetch. |
| `E_MODEL_LOAD` | model | no | A model file exists but failed to load. | Reinstall the model; check disk space. |
| `E_UNSUPPORTED_PLATFORM` | platform | no | The feature isn't supported on this OS/arch. | Use a supported platform (see README matrix). |
| `E_SIDECAR_MISSING` | platform | no | A helper sidecar is missing or exited nonzero. | Reinstall; ensure `say-avspeech` is beside the engine (macOS). |
| `E_NO_BACKEND` | platform | no | The binary was built without an ASR backend. | Use an official release build. |
| `E_TEXT_EMPTY` | tts | no | Synthesis text was empty. | Pass non-empty text. |
| `E_TEXT_TOO_LONG` | tts | no | Text exceeded the max length. | Split into shorter requests. |
| `E_VOICE_UNKNOWN` | tts | no | The voice id wasn't recognized. | `kesha say --list-voices`. |
| `E_SSML_INVALID` | tts | no | SSML was malformed (no `<speak>`, DOCTYPE, bad rate). | Fix the SSML; see `docs/tts.md`. |
| `E_SSML_UNSUPPORTED` | tts | no | SSML isn't supported for this engine/voice. | Use a plain-text request or a supported voice. |
| `E_TRANSCRIBE_FAILED` | transcribe | no | The ASR pipeline failed. | Re-run; file a bug with a support bundle. |
| `E_DIARIZE_TIMEOUT` | transcribe | yes | Diarization timed out (cold compile/long audio). | Re-run (warm); shorten audio. |
| `E_ENGINE_SPAWN` | internal | no | The CLI couldn't spawn the engine subprocess. | `kesha install`; check the engine binary path. |
| `E_INVALID_ARG` | input | no | A CLI flag/argument was invalid. | See `kesha --help`. |
| `E_INTERNAL` | internal | no | An unexpected/uncoded failure. | File a bug with `kesha support-bundle`. |
```

(Keep the table exactly these 19 rows so the drift gates pass.)

- [ ] **Step 2: Cross-link** — add to `README.md` (diagnostics/troubleshooting area): `See [Error codes](docs/errors.md) for stable failure codes.` Add the same link to `docs/diagnostic-logs.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/errors.md README.md docs/diagnostic-logs.md
git commit -m "docs: error-code reference (docs/errors.md)"
```

---

## Task 15: TS drift gate — engine ∪ TS-native == documented

**Files:**
- Test: `src/__tests__/error-codes-drift.test.ts` (create)

- [ ] **Step 1: Write the test** — create `src/__tests__/error-codes-drift.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { KNOWN_TS_CODES } from "../error-codes";

const ENGINE_BIN =
  process.env.KESHA_ENGINE_BIN ?? join(import.meta.dir, "../../rust/target/release/kesha-engine");

const describeOrSkip = existsSync(ENGINE_BIN) ? describe : describe.skip;

describeOrSkip("error-code drift", () => {
  test("engine codes ∪ TS-native codes == codes documented in docs/errors.md", () => {
    const res = spawnSync(ENGINE_BIN, ["--error-codes-json"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const engineCodes: string[] = JSON.parse(res.stdout).map((e: { code: string }) => e.code);

    const known = new Set<string>([...engineCodes, ...KNOWN_TS_CODES]);

    const doc = readFileSync(join(import.meta.dir, "../../docs/errors.md"), "utf8");
    const documented = new Set(doc.match(/E_[A-Z0-9_]+/g) ?? []);

    // every known code is documented
    for (const c of known) {
      expect(documented.has(c)).toBe(true);
    }
    // every documented code is known (no stale doc rows)
    for (const c of documented) {
      expect(known.has(c)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Build the engine, run the test**

Run: `cd rust && cargo build --release --features tts && cd .. && bun test src/__tests__/error-codes-drift.test.ts`
Expected: PASS (skips if the engine binary is absent).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/error-codes-drift.test.ts
git commit -m "test(cli): drift gate — engine ∪ TS codes == documented codes"
```

---

## Task 16: Engine release — version bumps

**Files:**
- Modify: `rust/Cargo.toml` (`version`)
- Modify: `rust/Cargo.lock` (via `cargo check`)
- Modify: `package.json` (`version` and `keshaEngine.version`)

- [ ] **Step 1: Pick the next version.** Read current values:

Run: `node -p "require('./package.json').version + ' / ' + require('./package.json').keshaEngine.version"` and `grep '^version' rust/Cargo.toml`
Choose the next patch/minor (e.g. if engine is `1.21.0`, use `1.22.0` — a feature). Set all three to the SAME value.

- [ ] **Step 2: Apply the bumps** — set `rust/Cargo.toml#version`, `package.json#version`, and `package.json#keshaEngine.version` to the chosen version, then refresh the lock:

Run: `cd rust && cargo check --features tts && cd ..`
Expected: `rust/Cargo.lock` updates the `kesha-engine` entry.

- [ ] **Step 3: Verify drift gate**

Run: `bun .github/scripts/check-versions.ts`
Expected: passes (`keshaEngine.version === rust/Cargo.toml#version`, `package.json#version >= keshaEngine.version`).

- [ ] **Step 4: Commit**

```bash
git add rust/Cargo.toml rust/Cargo.lock package.json
git commit -m "chore(release): bump engine + CLI for error taxonomy"
```

---

## Final verification (before PR)

- [ ] `cd rust && cargo fmt --check && cargo clippy --all-targets --features tts -- -D warnings`
- [ ] `cd rust && cargo check --features coreml --no-default-features` (backend module changed)
- [ ] `cd rust && cargo build --release --features tts && cargo nextest run --features tts`
- [ ] `bun test && bunx tsc --noEmit`
- [ ] Manual: `./rust/target/release/kesha-engine --error-codes-json | jq length` → `17`
- [ ] Manual: trigger a coded failure, confirm `error [E_...]:` on stderr
- [ ] Open PR with `Closes #462` (and `Refs #344, #345`), wait for CI + Greptile per CLAUDE.md.

---

## Self-review notes (coverage check vs spec)

- **Emit mechanism (`error [CODE]:`):** Task 2 (report) + Task 10 (say path). ✓
- **`CodedError`/`ErrorCode`/`coded_bail!`/`.coded()`:** Task 1. ✓
- **`--error-codes-json`:** Task 3. ✓
- **Catalogue (19 codes):** enum Task 1; engine wiring Tasks 4-10; TS-native in Task 12; documented Task 14. ✓
- **`file_not_found` → `E_INPUT_NOT_FOUND` migration:** Task 13 Step 3. ✓
- **TS hybrid wiring + diagnostic `error_code` field:** Task 13. ✓
- **Docs:** Task 14. ✓
- **Drift gates (Rust + TS):** Tasks 11, 15. ✓
- **Engine release:** Task 16. ✓
- **Exit codes unchanged:** asserted in Tasks 2/10 (report returns 1; say keeps `exit_code_for_tts_err`). ✓
- **Open item flagged in Task 9 Step 6:** whether input-existence is checked engine-side or TS-side — resolved as TS-owned (`E_INPUT_NOT_FOUND`) with engine decode failures as `E_BAD_AUDIO`. Implementer confirms via grep.
