# Bidirectional Voice — M1: Kokoro EN via ONNX (Plumbing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `kesha say "Hello"` on macOS/Linux/Windows using Kokoro-82M ONNX with a single English voice (`af_heart`), WAV-to-stdout, opt-in install. Validates the CLI contract, install flow, and cross-platform Rust build — zero FluidAudio, zero Silero, zero auto-routing. Those land in M2 and M3.

**Architecture:** Extend existing `kesha-engine` Rust binary with a `say` subcommand. Text → espeak-ng (dynamic link, system dep — see G2P decision below) → IPA phonemes → Kokoro tokenizer → Kokoro ONNX (via `ort`) → 24kHz mono f32 → WAV mux (`hound`) → stdout. TypeScript CLI adds a thin `say` subcommand that spawns the engine and pipes stdin/stdout. Models are downloaded opt-in via `kesha install --tts`.

**Tech Stack:** Rust (ort 2.0-rc, ndarray, hound, espeakng-sys), TypeScript (Bun, citty), ONNX Runtime, Kokoro-82M v1.0 ONNX from `onnx-community/Kokoro-82M-v1.0-ONNX`. Testing: `cargo test` for Rust, `bun test` for TS, full CI matrix.

**G2P decision (from Task 0.1 spike, 2026-04-16):**
- Crate: `espeakng-sys = "0.3.0"` with feature `clang-runtime` (loads libclang at runtime so bindgen's build script doesn't need `@rpath/libclang.dylib`).
- Linking: **dynamic** against system `libespeak-ng`. `espeakng-sys 0.3.0` has no vendored build; its `build.rs` is just `cargo:rustc-link-lib=espeak-ng`. Vendoring tracked in issue [#124](https://github.com/drakulavich/kesha-voice-kit/issues/124).
- Runtime prerequisite: `espeak-ng` installed via the host package manager (`brew install espeak-ng` / `apt install espeak-ng` / `choco install espeak-ng`). `kesha install --tts` must detect it and fail loudly with the exact command if missing.
- Generated-binding constants (bindgen-flattened from C enums): `espeak_AUDIO_OUTPUT_AUDIO_OUTPUT_SYNCHRONOUS`, `espeak_ERROR_EE_OK`, `espeakCHARS_UTF8`.
- `espeak_TextToPhonemes` phonememode value: `0x02` (bits 0-3 select character set; 2 = IPA). Bits 4-7 select output destination (0 = return from function). Verified by diffing spike output against `espeak-ng --ipa -q "Hello, world"`.
- `espeak_TextToPhonemes` returns only up to the next sentence terminator (comma, period). Callers must loop, advancing the `**text` pointer, until it returns null. Spike input "Hello, world" returned only `həlˈoʊ` for "Hello" before stopping at the comma — Task 4's implementation must handle this.
- macOS build env: `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib`, `RUSTFLAGS="-L /opt/homebrew/lib"`.
- macOS runtime: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` for dev, or `install_name_tool -change` fix-up in release binaries.

**Kokoro inference decision (from Task 0.2 spike, 2026-04-16):**
- Model SHA256: `8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb` (model.onnx, 326 MB — larger than the ~300MB plan estimate)
- Voice SHA256 (af_heart): `d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b` (522240 bytes)
- **Voice file is 510 rows × 256 cols, NOT 511.** Task 7's `EXPECTED` must be `510 * 256 * 4 = 522240`. Row index = `min(token_count - 1, 509)` (not 510).
- **Style tensor shape is `(1, 256)` rank-2, NOT `(1, 1, 256)` rank-3.** Task 0.2 plan step 3 (and Task 8) was wrong. Corrected form below.
- **Output tensor name is `"waveform"`, NOT `"audio"`.** Task 8 + Task 9's output access must use `outputs["waveform"]` or `outputs[0]`.
- Model inputs confirmed by probing `session.inputs()` at runtime:
  - `input_ids`: int64, shape `(1, N)` — token IDs, N up to 512 (padding to fixed 512 is a Task 5 concern, but inference accepts variable N)
  - `style`: float32, shape `(1, 256)` — single voice embedding row
  - `speed`: float32, shape `(1,)` — speaking rate
- Model output: `waveform`, float32 shape `(1, T)` @ 24kHz. For 8 placeholder tokens → T=32400 samples (1.35s).
- `ort 2.0.0-rc.12` API surface that worked (use verbatim in Task 8):
  ```rust
  use ort::session::Session;
  use ort::value::Value;
  use ndarray::{Array1, Array2};

  let mut session = Session::builder()?.commit_from_file(path)?;
  // Name/field accessors are methods, not fields:
  for input in session.inputs().iter() { println!("{:?}", input.name()); }
  // Value construction — note `.into_dyn()` is NOT required:
  let input_ids_val = Value::from_array(Array2::<i64>::from_shape_vec((1, n), tokens)?)?;
  let style_val     = Value::from_array(Array2::<f32>::from_shape_vec((1, 256), style)?)?;
  let speed_val     = Value::from_array(Array1::<f32>::from_vec(vec![1.0_f32]))?;
  let outputs = session.run(ort::inputs![
      "input_ids" => input_ids_val,
      "style"     => style_val,
      "speed"     => speed_val,
  ])?;
  let (shape, data) = outputs["waveform"].try_extract_tensor::<f32>()?;
  let samples: Vec<f32> = data.to_vec();
  ```
  Key gotchas: `Session::run()` needs `&mut self`; `inputs/outputs` on a Session are **methods** not fields; `input.name()` / `output.name()` are methods. No `.into_dyn()` needed when shape is rank-appropriate.
- Config vocab download: The URL pinned in the plan (`https://huggingface.co/hexgrad/Kokoro-82M/resolve/785407d1.../config.json`) returned `"Entry not found"` — the pinned commit doesn't have config.json at that path. Task 5 must either use a different URL (e.g., main branch of hexgrad/Kokoro-82M, or extract vocab from the ONNX-community v1.0-ONNX repo) or embed the vocab as a static JSON fixture copied manually from a known-good source.

**Testing discipline:** Every task follows Red/Green/Refactor. Every new module ships with both (a) unit tests that pin behavior and (b) an integration test path reached through the real CLI. No implementation-detail mocks. Tests resemble real usage (`echo ... | kesha say | file -` over `mock(KokoroSession)`).

---

## File Structure

**New files:**
- `rust/src/tts/mod.rs` — TTS public API: `say(text, voice_id) -> Vec<u8>` (WAV bytes)
- `rust/src/tts/g2p.rs` — espeak-ng wrapper: `text_to_ipa(text, lang) -> String`
- `rust/src/tts/tokenizer.rs` — IPA phonemes → Kokoro token IDs; pads to 512
- `rust/src/tts/kokoro.rs` — ONNX session, inference, voice loader
- `rust/src/tts/wav.rs` — WAV muxing (float32 24kHz mono → RIFF bytes)
- `rust/src/tts/voices.rs` — installed voice enumeration + manifest lookup
- `rust/tests/tts_e2e.rs` — integration tests against real models (gated by `KOKORO_MODEL` env var)
- `rust/fixtures/tts/hello_world_tokens.json` — golden phoneme-token pairs for deterministic tests
- `src/say.ts` — TS CLI handler
- `src/__tests__/say.test.ts` — unit tests for flag parsing and subprocess glue
- `tests/integration/say.test.ts` — e2e: real binary, real (small fixture) model
- `docs/tts-architecture.md` — user-facing design summary (short)

**Modified files:**
- `rust/Cargo.toml` — add `hound`, `espeakng-sys`, wire features
- `rust/src/main.rs` — add `say` subcommand to `clap`
- `rust/src/capabilities.rs` — advertise `tts.engines` and `tts.voices`
- `rust/src/models.rs` — add `download_tts_kokoro` + manifest entries
- `src/cli.ts` — register `say` subcommand in citty
- `src/lib.ts` — export `say()` and `downloadTts()`
- `src/models.ts` — re-export `downloadTts`
- `src/status.ts` — add TTS section to `kesha status`
- `src/engine-install.ts` — support `--tts` and `--voice` flags on install
- `.github/workflows/ci.yml` — add TTS test job per platform
- `scripts/smoke-test.ts` — add `kesha say` check
- `Makefile` — `test-tts`, `smoke-test-tts` targets
- `README.md` — add TTS section
- `CLAUDE.md` — add TTS-specific rules

---

## Task 0.1: Spike — Pin espeak-ng crate and verify static linking

**Purpose:** The plan assumes `espeakng-sys` exists and links statically. If it doesn't (or doesn't statically link cleanly), the whole G2P strategy shifts. De-risk up front.

**Files:**
- Create: `rust/spike-espeak/Cargo.toml` (throwaway)
- Create: `rust/spike-espeak/src/main.rs` (throwaway)
- Modify: `docs/superpowers/plans/2026-04-16-bidirectional-voice-m1-kokoro-en.md` (record decision)

- [ ] **Step 1: Create throwaway crate**

```bash
cd /Users/anton/Personal/repos/parakeet-cli/rust
cargo new --bin spike-espeak --vcs none
cd spike-espeak
```

- [ ] **Step 2: Try each candidate crate — record what happens**

Candidates to try in order: `espeakng-sys`, `espeakng`, `espeak-phonemizer`, `phonemizer-rust`.

For each, add it to `spike-espeak/Cargo.toml` and attempt a build:

```bash
cargo add espeakng-sys   # try first candidate
cargo build --release
```

Expected: one of these compiles and produces a binary that links `libespeak-ng` (either statically or dynamically — record which).

Check linkage:
```bash
# macOS
otool -L target/release/spike-espeak | grep -i espeak
# Linux
ldd target/release/spike-espeak | grep -i espeak
```

- [ ] **Step 3: Write minimal `text_to_ipa` smoke**

Goal: call the crate, get IPA phonemes for "Hello, world".

```rust
// rust/spike-espeak/src/main.rs
fn main() {
    // Exact API depends on pinned crate — fill in after Step 2.
    // Target behavior:
    let text = "Hello, world";
    let phonemes: String = /* crate-specific call */ unimplemented!();
    println!("{text} -> {phonemes}");
    // Expected output contains IPA like: həlˈoʊ wˈɜːld
}
```

- [ ] **Step 4: Run it**

```bash
cargo run --release -- "Hello, world"
```

Expected: stdout prints IPA-looking string. If it prints empty or errors, try next candidate.

- [ ] **Step 5: Pin the decision in this plan**

Edit the "Tech Stack" section of this file to record:
- Chosen crate name + version (e.g., `espeakng-sys = "0.1.4"`)
- Static vs dynamic linking status
- If dynamic: note the mitigation (bundle `libespeak-ng` alongside the binary OR document system install requirement) and re-open this plan section for the user's call

- [ ] **Step 6: Commit the decision (not the spike code)**

```bash
cd /Users/anton/Personal/repos/parakeet-cli
rm -rf rust/spike-espeak
git add docs/superpowers/plans/2026-04-16-bidirectional-voice-m1-kokoro-en.md
git commit -m "plan(m1): pin espeak-ng crate choice after spike

Chose <crate>@<version>, linking <static|dynamic>. See spike notes."
```

---

## Task 0.2: Spike — Kokoro ONNX end-to-end with hardcoded tokens

**Purpose:** Prove the Kokoro ONNX model runs under our existing `ort 2.0-rc.12` with a real voice embedding, producing non-silent 24kHz audio. Anything we learn here (tensor shape surprises, ort API quirks, voice file parsing) shapes later tasks.

**Files:**
- Create: `rust/spike-kokoro/Cargo.toml` (throwaway)
- Create: `rust/spike-kokoro/src/main.rs` (throwaway)
- Modify: `docs/superpowers/plans/2026-04-16-bidirectional-voice-m1-kokoro-en.md`

- [ ] **Step 1: Manually download model + voice**

```bash
mkdir -p /tmp/kokoro-spike
cd /tmp/kokoro-spike
curl -L -o model.onnx https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx
curl -L -o af_heart.bin https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin
curl -L -o config.json https://huggingface.co/hexgrad/Kokoro-82M/resolve/785407d1adfa7ae8fbef8ffd85f34ca127da3039/config.json
ls -la
```

Expected: `model.onnx` ~300MB, `af_heart.bin` ~524KB, `config.json` ~8KB.

- [ ] **Step 2: Create throwaway crate**

```bash
cd /Users/anton/Personal/repos/parakeet-cli/rust
cargo new --bin spike-kokoro --vcs none
cd spike-kokoro
cargo add ort@2.0.0-rc.12
cargo add ndarray@0.17
cargo add hound@3.5
```

- [ ] **Step 3: Write spike code**

```rust
// rust/spike-kokoro/src/main.rs
use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::Tensor;
use ndarray::Array;
use std::fs;
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let root = Path::new("/tmp/kokoro-spike");

    // Hardcoded token IDs for "Hello world" — derived from upstream demo notebook.
    // We'll replace this with real tokenization in the plan proper.
    let tokens: Vec<i64> = vec![
        0, 50, 83, 54, 156, 57, 135, 0, // rough placeholder; adjust if inference fails shape check
    ];
    let n = tokens.len();

    // Load voice embedding: 511 entries of [1, 1, 256] float32, indexed by token length.
    let voice_bytes = fs::read(root.join("af_heart.bin"))?;
    let voice_floats: Vec<f32> = voice_bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    // Shape: (511, 1, 256) per upstream demo; we pick row `n-1` but clamp to [0, 510].
    let row = (n - 1).min(510);
    let style: Vec<f32> = voice_floats[row * 256..(row + 1) * 256].to_vec();

    let session = Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .commit_from_file(root.join("model.onnx"))?;

    let input_ids = Tensor::from_array(Array::from_shape_vec((1, n), tokens)?.into_dyn())?;
    let style = Tensor::from_array(Array::from_shape_vec((1, 1, 256), style)?.into_dyn())?;
    let speed = Tensor::from_array(Array::from_shape_vec((1,), vec![1.0f32])?.into_dyn())?;

    let outputs = session.run(ort::inputs![
        "input_ids" => input_ids,
        "style" => style,
        "speed" => speed,
    ])?;

    let audio = outputs["audio"].try_extract_tensor::<f32>()?;
    let samples: Vec<f32> = audio.view().iter().copied().collect();
    println!("Generated {} samples at 24kHz ({:.2}s)", samples.len(), samples.len() as f32 / 24000.0);

    // Write WAV for ear-check
    let spec = hound::WavSpec { channels: 1, sample_rate: 24000, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(root.join("out.wav"), spec)?;
    for s in &samples { w.write_sample(*s)?; }
    w.finalize()?;
    println!("Wrote {}", root.join("out.wav").display());
    Ok(())
}
```

- [ ] **Step 4: Run it**

```bash
cargo run --release
```

Expected output (approximate):
```
Generated 12000 samples at 24kHz (0.50s)
Wrote /tmp/kokoro-spike/out.wav
```

Play the file; it should contain non-silent audio, even if gibberish due to placeholder tokens.

- [ ] **Step 5: Pin findings in this plan**

Record in this plan (edit tech-stack notes):
- Exact `ort` inputs API shape used (matches above, or needs adjustment)
- Voice embedding shape & indexing confirmed (or different)
- Any surprises (e.g., input names, output names)

If the shape is off, adjust Task 10 tensor wiring accordingly.

- [ ] **Step 6: Clean up**

```bash
rm -rf /Users/anton/Personal/repos/parakeet-cli/rust/spike-kokoro
# Keep /tmp/kokoro-spike/ around — integration tests will reuse it
git add docs/superpowers/plans/2026-04-16-bidirectional-voice-m1-kokoro-en.md
git commit -m "plan(m1): pin Kokoro ONNX tensor wiring after spike

Verified end-to-end inference produces 24kHz mono f32 audio via ort 2.0-rc.12."
```

---

## Task 1: Add Rust dependencies for TTS

**Files:**
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: Add deps**

Append to `rust/Cargo.toml` `[dependencies]`:

```toml
# TTS
hound = "3.5"                                  # WAV muxer
<espeak-crate-from-T0.1> = "<version>"         # G2P (pinned in Task 0.1)
```

And add a feature flag at `[features]`:

```toml
tts = []                                       # enables TTS subcommand + modules
default = ["onnx", "tts"]
```

- [ ] **Step 2: Verify build**

```bash
cd rust && cargo build --release
```

Expected: clean build, no new warnings.

- [ ] **Step 3: Commit**

```bash
git add rust/Cargo.toml rust/Cargo.lock
git commit -m "build(rust): add hound + espeak-ng deps for TTS module"
```

---

## Task 2: Stub `tts` module with failing integration test

**Files:**
- Create: `rust/src/tts/mod.rs`
- Modify: `rust/src/main.rs`
- Create: `rust/tests/tts_smoke.rs`

- [ ] **Step 1: Write the failing integration test**

```rust
// rust/tests/tts_smoke.rs
// Test that a `kesha-engine say` subcommand exists and prints help.
use std::process::Command;

#[test]
fn say_subcommand_exists() {
    let bin = env!("CARGO_BIN_EXE_kesha-engine");
    let out = Command::new(bin).args(["say", "--help"]).output().expect("run");
    assert!(out.status.success(), "say --help should exit 0, got {:?}\nstderr: {}",
            out.status, String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("--voice"), "help missing --voice: {stdout}");
}
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd rust && cargo test --test tts_smoke say_subcommand_exists
```

Expected: FAIL — "unrecognized subcommand 'say'".

- [ ] **Step 3: Add stub module and subcommand**

```rust
// rust/src/tts/mod.rs
//! Text-to-speech via Kokoro ONNX. See design doc 2026-04-16.
#![allow(dead_code)] // skeleton

pub mod g2p;
pub mod tokenizer;
pub mod kokoro;
pub mod wav;
pub mod voices;

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("voice '{0}' not installed. run: kesha install --tts --voice {1}")]
    VoiceNotInstalled(String, String),
    #[error("text is empty")]
    EmptyText,
    #[error("text exceeds {max} chars ({actual})")]
    TextTooLong { max: usize, actual: usize },
    #[error("synthesis failed: {0}")]
    SynthesisFailed(String),
}
```

Create empty submodules so the crate compiles:

```rust
// rust/src/tts/g2p.rs
// rust/src/tts/tokenizer.rs
// rust/src/tts/kokoro.rs
// rust/src/tts/wav.rs
// rust/src/tts/voices.rs
```

(Each is an empty file — one line `// TODO M1` is fine.)

Add the `tts` module and the `say` clap subcommand in `rust/src/main.rs`:

```rust
// At top
mod tts;

// In the enum Command / subcommand definition, add:
#[derive(clap::Subcommand)]
enum Command {
    // ... existing variants ...
    /// Synthesize speech from text (TTS)
    Say {
        /// Text to synthesize (omit to read from stdin)
        #[arg(trailing_var_arg = true)]
        text: Vec<String>,
        /// Voice id, e.g. `en-af_heart`
        #[arg(long)]
        voice: Option<String>,
        /// Output file (default: stdout)
        #[arg(long)]
        out: Option<std::path::PathBuf>,
        /// Output format
        #[arg(long, default_value = "wav")]
        format: String,
        /// Speaking rate (0.5–2.0)
        #[arg(long, default_value_t = 1.0)]
        rate: f32,
        /// List installed voices and exit
        #[arg(long)]
        list_voices: bool,
    },
}
```

In the `main` dispatch, handle `Say { .. }` with a stub `todo!()` — the test only checks `--help` exits cleanly.

Add `thiserror = "1"` to `rust/Cargo.toml` if not present.

- [ ] **Step 4: Run test — verify it passes**

```bash
cargo test --test tts_smoke say_subcommand_exists
```

Expected: PASS. Help text contains `--voice`.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts rust/src/main.rs rust/tests/tts_smoke.rs rust/Cargo.toml
git commit -m "feat(rust): add say subcommand skeleton with failing stub"
```

---

## Task 3: Advertise TTS capability

**Files:**
- Modify: `rust/src/capabilities.rs`
- Modify: `rust/tests/tts_smoke.rs`

- [ ] **Step 1: Write failing test**

Append to `rust/tests/tts_smoke.rs`:

```rust
#[test]
fn capabilities_advertises_tts() {
    let bin = env!("CARGO_BIN_EXE_kesha-engine");
    let out = Command::new(bin).arg("--capabilities").output().expect("run");
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("\"tts\""), "capabilities missing tts: {stdout}");
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cargo test --test tts_smoke capabilities_advertises_tts
```

Expected: FAIL — no "tts" in capabilities JSON.

- [ ] **Step 3: Extend `capabilities.rs`**

Find the existing `Capabilities` struct and add:

```rust
#[derive(serde::Serialize)]
pub struct TtsCapabilities {
    pub engines: Vec<String>,
    pub voices: Vec<String>,
}

// In the Capabilities struct:
pub tts: Option<TtsCapabilities>,
```

Populate in the `capabilities()` function: list installed voices by scanning `~/.cache/kesha/tts/`. For M1 it's enough to return `Some({ engines: ["kokoro"], voices: [] })` if the `tts` directory exists, `None` otherwise.

- [ ] **Step 4: Run — expect PASS**

```bash
cargo test --test tts_smoke capabilities_advertises_tts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/capabilities.rs rust/tests/tts_smoke.rs
git commit -m "feat(rust): advertise tts in --capabilities"
```

---

## Task 4: G2P module — text → IPA phonemes

**Files:**
- Modify: `rust/src/tts/g2p.rs`
- Create: `rust/src/tts/g2p_tests.rs` (or inline `#[cfg(test)]`)

- [ ] **Step 1: Write failing unit tests**

Replace `rust/src/tts/g2p.rs` with:

```rust
//! Grapheme-to-phoneme via statically-linked espeak-ng.

/// Convert text to IPA phonemes for the given language code (BCP-47).
/// Returns a phoneme string using espeak-ng's IPA output mode.
pub fn text_to_ipa(text: &str, lang: &str) -> anyhow::Result<String> {
    todo!("wire espeak-ng")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_world_produces_ipa() {
        let ipa = text_to_ipa("Hello, world", "en-us").unwrap();
        // Don't pin exact string — espeak-ng versions drift.
        // Just check shape: non-empty, contains common English IPA markers.
        assert!(!ipa.is_empty(), "ipa empty");
        assert!(ipa.chars().any(|c| matches!(c, 'h' | 'ə' | 'ˈ' | 'ː' | 'w')),
                "ipa looks wrong: {ipa}");
    }

    #[test]
    fn empty_text_ok() {
        let ipa = text_to_ipa("", "en-us").unwrap();
        assert!(ipa.is_empty() || ipa.trim().is_empty());
    }

    #[test]
    fn unsupported_lang_errors() {
        let err = text_to_ipa("hi", "xx-XX").unwrap_err();
        assert!(err.to_string().to_lowercase().contains("lang"),
                "expected lang error, got: {err}");
    }
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd rust && cargo test tts::g2p
```

Expected: FAIL — `todo!()` panics.

- [ ] **Step 3: Implement**

Using the crate pinned in Task 0.1. Template (adjust to actual crate API):

```rust
use anyhow::Context;

pub fn text_to_ipa(text: &str, lang: &str) -> anyhow::Result<String> {
    // One-time espeak init behind OnceLock
    static INIT: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    INIT.get_or_init(|| {
        // crate-specific init; e.g., espeakng_sys::espeak_Initialize(...)
    });

    // Set voice/language
    // e.g., espeakng_sys::espeak_SetVoiceByName(lang.as_ptr())
    //       returning non-zero → lang error
    /* … crate-specific language set, with:
       .context(format!("unsupported lang: {lang}"))? */

    if text.is_empty() {
        return Ok(String::new());
    }

    // Synthesize phonemes (mode = IPA)
    // e.g., espeakng_sys::espeak_TextToPhonemes(...)
    let ipa: String = /* crate call */ todo!();

    Ok(ipa.trim().to_string())
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cargo test tts::g2p
```

Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/g2p.rs
git commit -m "feat(rust): g2p module — text to IPA via espeak-ng"
```

---

## Task 5: Kokoro tokenizer — IPA → token IDs

**Files:**
- Modify: `rust/src/tts/tokenizer.rs`
- Create: `rust/fixtures/tts/kokoro_vocab.json` (committed, ~5KB, extracted from Kokoro config.json)

- [ ] **Step 1: Extract vocab**

Download Kokoro config.json (if not already from Task 0.2):

```bash
curl -L -o /tmp/kokoro-config.json \
  https://huggingface.co/hexgrad/Kokoro-82M/resolve/785407d1adfa7ae8fbef8ffd85f34ca127da3039/config.json
```

Extract the phoneme-to-id map into a committable fixture:

```bash
jq '.vocab' /tmp/kokoro-config.json > rust/fixtures/tts/kokoro_vocab.json
ls -lh rust/fixtures/tts/kokoro_vocab.json   # expect a few KB
```

- [ ] **Step 2: Write failing tests**

```rust
// rust/src/tts/tokenizer.rs
//! Kokoro phoneme → token ID vocabulary.

use std::collections::HashMap;

const VOCAB_JSON: &str = include_str!("../../fixtures/tts/kokoro_vocab.json");

pub struct Tokenizer {
    map: HashMap<String, i64>,
}

impl Tokenizer {
    pub fn load() -> anyhow::Result<Self> {
        let map: HashMap<String, i64> = serde_json::from_str(VOCAB_JSON)?;
        Ok(Self { map })
    }

    /// Encode an IPA string into Kokoro token IDs.
    /// Unknown characters are dropped with a debug log.
    pub fn encode(&self, ipa: &str) -> Vec<i64> {
        ipa.chars()
            .filter_map(|c| {
                let s = c.to_string();
                self.map.get(&s).copied()
            })
            .collect()
    }

    /// Pad/truncate to Kokoro's max context (510 active tokens + 2 pad).
    /// Returns shape-(512,) padded with 0s.
    pub fn pad_to_context(mut ids: Vec<i64>) -> Vec<i64> {
        if ids.len() > 510 { ids.truncate(510); }
        let mut out = Vec::with_capacity(512);
        out.push(0);
        out.extend(ids);
        out.push(0);
        while out.len() < 512 { out.push(0); }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocab_loads() {
        let t = Tokenizer::load().unwrap();
        assert!(t.map.len() > 50, "vocab too small: {}", t.map.len());
    }

    #[test]
    fn encodes_known_phoneme() {
        let t = Tokenizer::load().unwrap();
        // The space character is in the Kokoro vocab; pick any guaranteed entry.
        let ids = t.encode(" ");
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn drops_unknown() {
        let t = Tokenizer::load().unwrap();
        let ids = t.encode("\u{E000}"); // Private use area — not in vocab
        assert!(ids.is_empty());
    }

    #[test]
    fn pads_short_to_512() {
        let padded = Tokenizer::pad_to_context(vec![1, 2, 3]);
        assert_eq!(padded.len(), 512);
        assert_eq!(&padded[..5], &[0, 1, 2, 3, 0]);
    }

    #[test]
    fn truncates_long_to_512() {
        let ids: Vec<i64> = (1..=600).collect();
        let padded = Tokenizer::pad_to_context(ids);
        assert_eq!(padded.len(), 512);
    }
}
```

- [ ] **Step 3: Run — expect FAIL (file-not-found)**

```bash
cd rust && cargo test tts::tokenizer
```

Expected: FAIL — missing fixture or empty map.

- [ ] **Step 4: Verify the fixture was committed**

```bash
head -c 200 rust/fixtures/tts/kokoro_vocab.json
```

Expected: JSON object with phoneme keys.

- [ ] **Step 5: Run — expect PASS**

```bash
cargo test tts::tokenizer
```

Expected: PASS — all 5 tests.

- [ ] **Step 6: Commit**

```bash
git add rust/src/tts/tokenizer.rs rust/fixtures/tts/kokoro_vocab.json
git commit -m "feat(rust): kokoro tokenizer — IPA to token IDs with pad/truncate"
```

---

## Task 6: WAV muxer

**Files:**
- Modify: `rust/src/tts/wav.rs`

- [ ] **Step 1: Write failing tests**

```rust
// rust/src/tts/wav.rs
//! WAV muxing: f32 samples → WAV 24kHz mono bytes.

use std::io::Cursor;

/// Encode mono float32 samples @ 24kHz as a RIFF WAV byte buffer.
pub fn encode_wav(samples: &[f32], sample_rate: u32) -> anyhow::Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut buf = Cursor::new(Vec::<u8>::new());
    {
        let mut w = hound::WavWriter::new(&mut buf, spec)?;
        for s in samples { w.write_sample(*s)?; }
        w.finalize()?;
    }
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_riff_header() {
        let samples = vec![0.0f32; 24000];
        let wav = encode_wav(&samples, 24000).unwrap();
        assert_eq!(&wav[..4], b"RIFF", "not a RIFF: {:?}", &wav[..4]);
        assert_eq!(&wav[8..12], b"WAVE");
    }

    #[test]
    fn round_trip_through_hound() {
        let samples: Vec<f32> = (0..2400).map(|i| (i as f32 * 0.1).sin()).collect();
        let wav = encode_wav(&samples, 24000).unwrap();
        let reader = hound::WavReader::new(std::io::Cursor::new(&wav)).unwrap();
        assert_eq!(reader.spec().sample_rate, 24000);
        assert_eq!(reader.spec().channels, 1);
        let decoded: Vec<f32> = reader.into_samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(decoded.len(), 2400);
        assert!((decoded[100] - samples[100]).abs() < 1e-6);
    }
}
```

- [ ] **Step 2: Run — expect PASS immediately**

(Implementation was included in Step 1 since `hound` is already a dep and the function is tiny. This is explicit: we're not padding TDD for its own sake; the test pins behavior.)

```bash
cd rust && cargo test tts::wav
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add rust/src/tts/wav.rs
git commit -m "feat(rust): wav muxer for f32 mono samples"
```

---

## Task 7: Voice file loader

**Files:**
- Modify: `rust/src/tts/voices.rs`

- [ ] **Step 1: Write failing tests**

```rust
// rust/src/tts/voices.rs
//! Load Kokoro voice embeddings from .bin files.

use std::path::Path;

/// Load a Kokoro voice file: 511 rows × [1, 1, 256] float32.
/// Returns a flat Vec of 511*256 floats.
pub fn load_voice(path: &Path) -> anyhow::Result<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    const EXPECTED: usize = 511 * 256 * 4;
    if bytes.len() != EXPECTED {
        anyhow::bail!("voice file size {} != expected {}", bytes.len(), EXPECTED);
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Pick the style embedding row for a given token count.
pub fn select_style(voice: &[f32], token_count: usize) -> &[f32] {
    let row = token_count.saturating_sub(1).min(510);
    &voice[row * 256..(row + 1) * 256]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn load_rejects_wrong_size() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(&[0u8; 100]).unwrap();
        let err = load_voice(tmp.path()).unwrap_err();
        assert!(err.to_string().contains("voice file size"));
    }

    #[test]
    fn load_ok_for_correct_size() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        let bytes = vec![0u8; 511 * 256 * 4];
        tmp.write_all(&bytes).unwrap();
        let voice = load_voice(tmp.path()).unwrap();
        assert_eq!(voice.len(), 511 * 256);
    }

    #[test]
    fn select_style_clamps_high_indices() {
        let voice = vec![0.0; 511 * 256];
        let s = select_style(&voice, 10_000);
        assert_eq!(s.len(), 256);
    }

    #[test]
    fn select_style_clamps_zero() {
        let voice = vec![0.0; 511 * 256];
        let s = select_style(&voice, 0);
        assert_eq!(s.len(), 256);
    }
}
```

Add `tempfile = "3"` to `[dev-dependencies]` in `rust/Cargo.toml`.

- [ ] **Step 2: Run tests**

```bash
cd rust && cargo test tts::voices
```

Expected: PASS (implementation inlined above).

- [ ] **Step 3: Commit**

```bash
git add rust/src/tts/voices.rs rust/Cargo.toml rust/Cargo.lock
git commit -m "feat(rust): voice embedding loader"
```

---

## Task 8: Kokoro ONNX inference

**Files:**
- Modify: `rust/src/tts/kokoro.rs`
- Modify: `rust/src/tts/mod.rs` (add `pub use`)

- [ ] **Step 1: Write failing integration test (gated on real model presence)**

```rust
// rust/src/tts/kokoro.rs
//! Kokoro ONNX inference session.

use std::path::Path;

pub struct Kokoro {
    session: ort::session::Session,
}

impl Kokoro {
    pub fn load(model_path: &Path) -> anyhow::Result<Self> {
        let session = ort::session::Session::builder()?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
            .commit_from_file(model_path)?;
        Ok(Self { session })
    }

    /// Run inference. `input_ids` must be length 512 (pre-padded).
    /// `style` must be length 256. Returns 24kHz mono f32 audio.
    pub fn infer(&mut self, input_ids: &[i64], style: &[f32], speed: f32) -> anyhow::Result<Vec<f32>> {
        use ndarray::Array;
        use ort::value::Tensor;

        anyhow::ensure!(input_ids.len() == 512, "input_ids must be 512, got {}", input_ids.len());
        anyhow::ensure!(style.len() == 256, "style must be 256, got {}", style.len());

        let ids = Tensor::from_array(
            Array::from_shape_vec((1, 512), input_ids.to_vec())?.into_dyn()
        )?;
        let st = Tensor::from_array(
            Array::from_shape_vec((1, 1, 256), style.to_vec())?.into_dyn()
        )?;
        let sp = Tensor::from_array(
            Array::from_shape_vec((1,), vec![speed])?.into_dyn()
        )?;

        let outputs = self.session.run(ort::inputs![
            "input_ids" => ids,
            "style" => st,
            "speed" => sp,
        ])?;
        let audio = outputs["audio"].try_extract_tensor::<f32>()?;
        Ok(audio.view().iter().copied().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only runs if KOKORO_MODEL env var points to a real model file.
    /// Kept out of default test run to avoid CI pulling 300MB.
    #[test]
    fn infer_produces_non_silent_audio() {
        let Some(path) = std::env::var_os("KOKORO_MODEL") else {
            eprintln!("KOKORO_MODEL not set; skipping");
            return;
        };
        let mut k = Kokoro::load(Path::new(&path)).unwrap();
        let ids = vec![0i64; 512];
        // Token 0 everywhere is silence-like; we just want a shape+non-crash check.
        let style = vec![0.0f32; 256];
        let audio = k.infer(&ids, &style, 1.0).unwrap();
        assert!(audio.len() > 1000, "expected non-trivial audio length");
    }
}
```

- [ ] **Step 2: Run without env var — should skip cleanly**

```bash
cd rust && cargo test tts::kokoro
```

Expected: PASS (test body early-returns).

- [ ] **Step 3: Run with real model — verify actual inference**

```bash
KOKORO_MODEL=/tmp/kokoro-spike/model.onnx cargo test tts::kokoro -- --nocapture
```

Expected: PASS — `audio.len() > 1000`.

- [ ] **Step 4: Commit**

```bash
git add rust/src/tts/kokoro.rs
git commit -m "feat(rust): kokoro onnx inference session"
```

---

## Task 9: Top-level `tts::say` orchestrator

**Files:**
- Modify: `rust/src/tts/mod.rs`

- [ ] **Step 1: Write failing integration test**

```rust
// Append to rust/src/tts/mod.rs

use std::path::Path;

pub struct SayOptions<'a> {
    pub text: &'a str,
    pub lang: &'a str,              // "en-us"
    pub speed: f32,
    pub model_path: &'a Path,
    pub voice_path: &'a Path,
}

pub fn say(opts: SayOptions) -> Result<Vec<u8>, TtsError> {
    if opts.text.is_empty() {
        return Err(TtsError::EmptyText);
    }
    if opts.text.len() > 5000 {
        return Err(TtsError::TextTooLong { max: 5000, actual: opts.text.len() });
    }

    let ipa = g2p::text_to_ipa(opts.text, opts.lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    let tok = tokenizer::Tokenizer::load()
        .map_err(|e| TtsError::SynthesisFailed(format!("tokenizer: {e}")))?;
    let ids = tok.encode(&ipa);
    let token_count = ids.len();
    let padded = tokenizer::Tokenizer::pad_to_context(ids);

    let voice = voices::load_voice(opts.voice_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("voice: {e}")))?;
    let style = voices::select_style(&voice, token_count);

    let mut k = kokoro::Kokoro::load(opts.model_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("kokoro load: {e}")))?;
    let audio = k.infer(&padded, style, opts.speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    let wav = wav::encode_wav(&audio, 24_000)
        .map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))?;
    Ok(wav)
}
```

Add integration test `rust/tests/tts_e2e.rs`:

```rust
// rust/tests/tts_e2e.rs
//! End-to-end TTS: real model, real voice, real espeak-ng — produces real WAV bytes.
//! Gated on KOKORO_MODEL + KOKORO_VOICE env vars so CI without models stays fast.

use std::path::Path;

#[test]
fn hello_world_produces_wav() {
    let (model, voice) = match (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        (Ok(m), Ok(v)) => (m, v),
        _ => { eprintln!("skipping: set KOKORO_MODEL + KOKORO_VOICE"); return; }
    };
    let wav = kesha_engine::tts::say(kesha_engine::tts::SayOptions {
        text: "Hello, world",
        lang: "en-us",
        speed: 1.0,
        model_path: Path::new(&model),
        voice_path: Path::new(&voice),
    }).unwrap();
    assert_eq!(&wav[..4], b"RIFF", "not a WAV");
    assert!(wav.len() > 44 + 1000 * 4, "audio too short: {} bytes", wav.len());
}

#[test]
fn empty_text_errors() {
    let res = kesha_engine::tts::say(kesha_engine::tts::SayOptions {
        text: "",
        lang: "en-us",
        speed: 1.0,
        model_path: Path::new("/nonexistent"),
        voice_path: Path::new("/nonexistent"),
    });
    assert!(matches!(res, Err(kesha_engine::tts::TtsError::EmptyText)));
}
```

Expose as library crate: in `rust/Cargo.toml`:

```toml
[lib]
name = "kesha_engine"
path = "src/lib.rs"

[[bin]]
name = "kesha-engine"
path = "src/main.rs"
```

Create `rust/src/lib.rs`:

```rust
//! Public library surface for integration tests.
pub mod tts;
```

- [ ] **Step 2: Run tests**

```bash
cd rust && cargo test --test tts_e2e empty_text_errors
KOKORO_MODEL=/tmp/kokoro-spike/model.onnx KOKORO_VOICE=/tmp/kokoro-spike/af_heart.bin \
  cargo test --test tts_e2e hello_world_produces_wav -- --nocapture
```

Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add rust/src/tts/mod.rs rust/src/lib.rs rust/Cargo.toml rust/tests/tts_e2e.rs
git commit -m "feat(rust): tts::say orchestrator — text in, WAV out"
```

---

## Task 10: Wire `say` subcommand to the orchestrator

**Files:**
- Modify: `rust/src/main.rs`

- [ ] **Step 1: Write failing integration test**

Append to `rust/tests/tts_smoke.rs`:

```rust
#[test]
fn say_with_hardcoded_paths_produces_wav() {
    let (model, voice) = match (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        (Ok(m), Ok(v)) => (m, v),
        _ => { eprintln!("skipping: set KOKORO_MODEL + KOKORO_VOICE"); return; }
    };
    let bin = env!("CARGO_BIN_EXE_kesha-engine");
    let out = Command::new(bin)
        .args([
            "say", "Hello, world",
            "--model", &model,
            "--voice-file", &voice,
            "--lang", "en-us",
        ])
        .output().expect("run");
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(&out.stdout[..4], b"RIFF");
}
```

- [ ] **Step 2: Run — expect FAIL (args unknown)**

```bash
cd rust && cargo test --test tts_smoke say_with_hardcoded_paths_produces_wav
```

Expected: FAIL — unrecognized args.

- [ ] **Step 3: Extend clap subcommand + dispatcher**

In `main.rs`, extend the `Say { .. }` variant with:

```rust
Say {
    #[arg(trailing_var_arg = true)]
    text: Vec<String>,
    #[arg(long)]
    voice: Option<String>,
    #[arg(long, default_value = "en-us")]
    lang: String,
    #[arg(long)]
    out: Option<std::path::PathBuf>,
    #[arg(long, default_value = "wav")]
    format: String,
    #[arg(long, default_value_t = 1.0)]
    rate: f32,
    #[arg(long)]
    list_voices: bool,
    /// Explicit model path (testing override — normally resolved from cache)
    #[arg(long, hide = true)]
    model: Option<std::path::PathBuf>,
    /// Explicit voice embedding path (testing override)
    #[arg(long = "voice-file", hide = true)]
    voice_file: Option<std::path::PathBuf>,
},
```

Handle in dispatch:

```rust
Command::Say { text, lang, rate, out, model, voice_file, list_voices, .. } => {
    if list_voices {
        // M1: print empty list + hint
        println!("No voices installed. Run: kesha install --tts");
        return Ok(());
    }
    let text_joined = if text.is_empty() {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?;
        s.trim().to_string()
    } else {
        text.join(" ")
    };
    // M1: require explicit --model / --voice-file (proper resolution lands in Task 14)
    let model = model.ok_or_else(|| anyhow::anyhow!("--model required in M1"))?;
    let voice_file = voice_file.ok_or_else(|| anyhow::anyhow!("--voice-file required in M1"))?;

    let wav = tts::say(tts::SayOptions {
        text: &text_joined,
        lang: &lang,
        speed: rate,
        model_path: &model,
        voice_path: &voice_file,
    })?;

    match out {
        Some(p) => std::fs::write(&p, &wav)?,
        None => {
            use std::io::Write;
            std::io::stdout().write_all(&wav)?;
        }
    }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
KOKORO_MODEL=/tmp/kokoro-spike/model.onnx KOKORO_VOICE=/tmp/kokoro-spike/af_heart.bin \
  cargo test --test tts_smoke say_with_hardcoded_paths_produces_wav -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/main.rs rust/tests/tts_smoke.rs
git commit -m "feat(rust): wire say subcommand to tts orchestrator"
```

---

## Task 11: Error taxonomy + exit codes

**Files:**
- Modify: `rust/src/main.rs`
- Modify: `rust/src/tts/mod.rs`

- [ ] **Step 1: Write failing test**

Add to `rust/tests/tts_smoke.rs`:

```rust
#[test]
fn empty_text_exits_2() {
    let bin = env!("CARGO_BIN_EXE_kesha-engine");
    let out = Command::new(bin)
        .args(["say", "", "--model", "/dev/null", "--voice-file", "/dev/null", "--lang", "en-us"])
        .output().expect("run");
    assert_eq!(out.status.code(), Some(2), "stderr: {}", String::from_utf8_lossy(&out.stderr));
}
```

- [ ] **Step 2: Run — expect FAIL (current implementation returns 1)**

- [ ] **Step 3: Map errors to exit codes**

In `main.rs`, introduce a helper:

```rust
fn exit_code_for_tts_err(e: &tts::TtsError) -> i32 {
    match e {
        tts::TtsError::VoiceNotInstalled(..) => 1,
        tts::TtsError::EmptyText | tts::TtsError::TextTooLong { .. } => 2,
        tts::TtsError::SynthesisFailed(_) => 4,
    }
}
```

In the `Say` dispatch, match on errors and exit with the mapped code, printing the error to stderr.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Add similar tests + wiring for each code (1,3,4,5)**

One test per exit code, each using a minimal triggering input. Keep each test <10 lines.

- [ ] **Step 6: Commit**

```bash
git add rust/src/main.rs rust/src/tts/mod.rs rust/tests/tts_smoke.rs
git commit -m "feat(rust): tts error taxonomy with numbered exit codes"
```

---

## Task 12: Model download — extend `models.rs`

**Files:**
- Modify: `rust/src/models.rs`

- [ ] **Step 1: Write failing test**

```rust
// In rust/src/models.rs (or tests/models_tts.rs)
#[cfg(test)]
mod tts_tests {
    use super::*;
    #[test]
    fn kokoro_manifest_has_expected_files() {
        let m = kokoro_manifest();
        assert!(m.iter().any(|f| f.rel_path == "tts/kokoro-82m/model.onnx"));
        assert!(m.iter().any(|f| f.rel_path == "tts/kokoro-82m/voices/af_heart.bin"));
        for f in &m {
            assert!(!f.sha256.is_empty(), "{:?} missing sha256", f);
            assert!(f.size_bytes > 0, "{:?} missing size", f);
        }
    }
}
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `kokoro_manifest()`**

```rust
#[derive(Debug)]
pub struct ModelFile {
    pub rel_path: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

pub fn kokoro_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            rel_path: "tts/kokoro-82m/model.onnx",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
            sha256: "<sha-from-download>",  // fill after Task 0.2 spike via `shasum -a 256`
            size_bytes: 0,                    // fill after download
        },
        ModelFile {
            rel_path: "tts/kokoro-82m/voices/af_heart.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin",
            sha256: "<sha>",
            size_bytes: 0,
        },
    ]
}

pub fn download_tts_kokoro(cache: &Path, verify: bool) -> anyhow::Result<()> {
    for f in kokoro_manifest() {
        let target = cache.join(f.rel_path);
        if target.exists() && verify_sha256(&target, f.sha256)? { continue; }
        std::fs::create_dir_all(target.parent().unwrap())?;
        let resp = ureq::get(f.url).call()?;
        let bytes = resp.into_body().read_to_vec()?;
        std::fs::write(&target, &bytes)?;
        if verify && !verify_sha256(&target, f.sha256)? {
            anyhow::bail!("sha256 mismatch for {}", f.rel_path);
        }
    }
    Ok(())
}
```

Checksums: run the spike's `shasum -a 256 /tmp/kokoro-spike/model.onnx` once and paste the value.

- [ ] **Step 4: Test — expect PASS**

- [ ] **Step 5: Add install-path integration test**

```rust
// rust/tests/models_tts.rs
#[test]
fn download_writes_files() {
    let tmp = tempfile::tempdir().unwrap();
    kesha_engine::models::download_tts_kokoro(tmp.path(), true).unwrap();
    assert!(tmp.path().join("tts/kokoro-82m/model.onnx").exists());
}
```

(Mark `#[ignore]` by default — only runs with `--ignored` because it downloads ~300MB.)

- [ ] **Step 6: Commit**

```bash
git add rust/src/models.rs rust/tests/models_tts.rs
git commit -m "feat(rust): kokoro model download with sha256 verification"
```

---

## Task 13: `kesha-engine install --tts` subcommand

**Files:**
- Modify: `rust/src/main.rs`

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn install_tts_creates_cache_layout() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_kesha-engine");
    let out = Command::new(bin)
        .env("KESHA_CACHE_DIR", tmp.path())
        .args(["install", "--tts"])
        .output().expect("run");
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(tmp.path().join("tts/kokoro-82m/model.onnx").exists());
}
```

(Mark `#[ignore]` — large download.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Add `--tts` to existing install subcommand; respect `KESHA_CACHE_DIR`**

- [ ] **Step 4: Run — expect PASS (`--ignored`)**

- [ ] **Step 5: Commit**

```bash
git add rust/src/main.rs
git commit -m "feat(rust): install --tts downloads Kokoro + af_heart"
```

---

## Task 14: Voice resolution from cache

**Files:**
- Modify: `rust/src/tts/voices.rs`
- Modify: `rust/src/main.rs`

- [ ] **Step 1: Write failing tests**

```rust
// In voices.rs
#[test]
fn resolve_installed_voice() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("tts/kokoro-82m/voices");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("af_heart.bin"), vec![0u8; 511*256*4]).unwrap();
    let resolved = resolve_voice(tmp.path(), "en-af_heart").unwrap();
    assert!(resolved.voice_path.ends_with("af_heart.bin"));
    assert!(resolved.model_path.ends_with("model.onnx") || resolved.model_path.exists() == false);
}

#[test]
fn resolve_missing_voice_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let err = resolve_voice(tmp.path(), "en-af_heart").unwrap_err();
    assert!(err.to_string().contains("not installed"));
}
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `resolve_voice`**

```rust
pub struct ResolvedVoice {
    pub voice_path: std::path::PathBuf,
    pub model_path: std::path::PathBuf,
    pub lang: &'static str,
}

pub fn resolve_voice(cache: &Path, voice_id: &str) -> anyhow::Result<ResolvedVoice> {
    // Format: "<lang>-<voice-name>", e.g., "en-af_heart"
    let (lang, name) = voice_id.split_once('-')
        .ok_or_else(|| anyhow::anyhow!("voice id must be 'lang-name' (got '{voice_id}')"))?;
    let voice_path = cache.join("tts/kokoro-82m/voices").join(format!("{name}.bin"));
    let model_path = cache.join("tts/kokoro-82m/model.onnx");
    if !voice_path.exists() {
        anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
    }
    // lang_code for espeak
    let espeak_lang = match lang {
        "en" => "en-us",
        other => anyhow::bail!("language '{other}' not supported in M1"),
    };
    Ok(ResolvedVoice { voice_path, model_path, lang: espeak_lang })
}
```

Default voice for M1: `en-af_heart`. Update the `Say` dispatch to use `resolve_voice` when `--voice-file` is not provided.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/voices.rs rust/src/main.rs
git commit -m "feat(rust): resolve voice id from cache; default en-af_heart"
```

---

## Task 15: TypeScript — `src/say.ts` module

**Files:**
- Create: `src/say.ts`
- Create: `src/__tests__/say.test.ts`

- [ ] **Step 1: Write failing unit tests**

```typescript
// src/__tests__/say.test.ts
import { describe, it, expect } from "bun:test";
import { buildSayArgs } from "../say";

describe("buildSayArgs", () => {
  it("passes text as positional", () => {
    expect(buildSayArgs({ text: "Hello" })).toContain("Hello");
  });

  it("includes --voice when given", () => {
    expect(buildSayArgs({ text: "Hi", voice: "en-af_heart" }))
      .toEqual(expect.arrayContaining(["--voice", "en-af_heart"]));
  });

  it("includes --out when given", () => {
    expect(buildSayArgs({ text: "Hi", out: "reply.wav" }))
      .toEqual(expect.arrayContaining(["--out", "reply.wav"]));
  });

  it("defaults rate to 1.0 — omitted when default", () => {
    const args = buildSayArgs({ text: "Hi" });
    expect(args).not.toContain("--rate");
  });

  it("includes --rate only when non-default", () => {
    const args = buildSayArgs({ text: "Hi", rate: 1.2 });
    expect(args).toEqual(expect.arrayContaining(["--rate", "1.2"]));
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test src/__tests__/say.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/say.ts`**

```typescript
// src/say.ts
import { spawn } from "bun";
import { findEngine } from "./engine";

export interface SayOptions {
  text?: string;
  voice?: string;
  lang?: string;
  out?: string;
  format?: "wav";
  rate?: number;
}

export function buildSayArgs(o: SayOptions): string[] {
  const args: string[] = ["say"];
  if (o.voice) args.push("--voice", o.voice);
  if (o.lang) args.push("--lang", o.lang);
  if (o.out) args.push("--out", o.out);
  if (o.format && o.format !== "wav") args.push("--format", o.format);
  if (o.rate !== undefined && o.rate !== 1.0) args.push("--rate", String(o.rate));
  if (o.text) args.push(o.text);
  return args;
}

export async function say(opts: SayOptions): Promise<Uint8Array> {
  const bin = await findEngine();
  const args = buildSayArgs({ ...opts, text: undefined }); // text goes via stdin
  const child = spawn([bin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (opts.text !== undefined) {
    child.stdin.write(opts.text);
    await child.stdin.end();
  }
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`kesha-engine say exited ${exit}: ${stderr}`);
  }
  return new Uint8Array(stdout);
}
```

(Assumes `src/engine.ts` already exports `findEngine()` — reuse the existing helper from ASR side. If named differently, update.)

- [ ] **Step 4: Run — expect PASS**

```bash
bun test src/__tests__/say.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/say.ts src/__tests__/say.test.ts
git commit -m "feat(ts): src/say.ts module with buildSayArgs unit tests"
```

---

## Task 16: TypeScript — wire `say` in citty CLI

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing integration test**

```typescript
// tests/integration/say.test.ts
import { describe, it, expect } from "bun:test";
import { spawn } from "bun";

describe("kesha say (integration)", () => {
  it("--help exits 0", async () => {
    const { stdout, exited } = spawn(["bun", "bin/kesha.js", "say", "--help"], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(await exited).toBe(0);
    const s = await new Response(stdout).text();
    expect(s).toContain("--voice");
  });

  it("missing install shows actionable error", async () => {
    const { stderr, exited } = spawn(
      ["bun", "bin/kesha.js", "say", "Hello"],
      { env: { ...process.env, KESHA_CACHE_DIR: "/tmp/kesha-empty-" + Date.now() },
        stderr: "pipe", stdout: "pipe" },
    );
    const rc = await exited;
    expect(rc).toBe(1);
    const err = await new Response(stderr).text();
    expect(err).toMatch(/install --tts/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/integration/say.test.ts
```

- [ ] **Step 3: Register subcommand in citty**

In `src/cli.ts` add:

```typescript
const sayCmd = defineCommand({
  meta: { name: "say", description: "Synthesize speech from text (TTS)" },
  args: {
    text: { type: "positional", required: false },
    voice: { type: "string" },
    lang: { type: "string" },
    out: { type: "string" },
    format: { type: "string", default: "wav" },
    rate: { type: "string", default: "1.0" },
    "list-voices": { type: "boolean" },
  },
  async run({ args }) {
    const { say } = await import("./say.js");
    const wav = await say({
      text: args.text as string | undefined,
      voice: args.voice as string | undefined,
      lang: args.lang as string | undefined,
      out: args.out as string | undefined,
      rate: Number(args.rate),
    });
    if (!args.out) {
      process.stdout.write(wav);
    }
  },
});

// Register alongside existing subcommands
mainCmd.subCommands = { ...mainCmd.subCommands, say: sayCmd };
```

- [ ] **Step 4: Run — expect PASS (first test). Second needs Task 17.**

```bash
bun test tests/integration/say.test.ts -t "help exits 0"
```

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/integration/say.test.ts
git commit -m "feat(ts): register say subcommand in citty CLI"
```

---

## Task 17: First-run install hint + `KESHA_CACHE_DIR`

**Files:**
- Modify: `src/say.ts`
- Modify: `rust/src/main.rs`

- [ ] **Step 1: Write failing test** (already in Task 16 as the second `it()`)

- [ ] **Step 2: Plumb `KESHA_CACHE_DIR` through engine**

In `rust/src/main.rs`, resolve cache directory:
```rust
fn cache_dir() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("KESHA_CACHE_DIR") { return Ok(PathBuf::from(p)); }
    let d = dirs::cache_dir().ok_or_else(|| anyhow::anyhow!("no cache dir"))?;
    Ok(d.join("kesha"))
}
```

In the `Say` dispatch, call `resolve_voice(&cache_dir()?, voice.as_deref().unwrap_or("en-af_heart"))`. On `VoiceNotInstalled`, print the actionable hint to stderr and `std::process::exit(1)`.

- [ ] **Step 3: Run — expect PASS**

```bash
bun test tests/integration/say.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/say.ts rust/src/main.rs
git commit -m "feat: honor KESHA_CACHE_DIR; first-run hint when voice missing"
```

---

## Task 18: `kesha install --tts` TS plumbing

**Files:**
- Modify: `src/engine-install.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/engine-install.test.ts
import { describe, it, expect } from "bun:test";
import { parseInstallArgs } from "../engine-install";

describe("parseInstallArgs", () => {
  it("recognizes --tts", () => {
    expect(parseInstallArgs(["--tts"])).toEqual({ tts: true, voices: [] });
  });
  it("recognizes --tts --voice en", () => {
    expect(parseInstallArgs(["--tts", "--voice", "en"])).toEqual({ tts: true, voices: ["en"] });
  });
  it("recognizes comma list", () => {
    expect(parseInstallArgs(["--tts", "--voice", "en,ru"])).toEqual({ tts: true, voices: ["en", "ru"] });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `parseInstallArgs` + hook into existing install flow**

Install flow calls `kesha-engine install --tts [--voice <id>]`.

- [ ] **Step 4: Integration test**

```typescript
// tests/integration/install.test.ts (extend existing)
it("install --tts downloads Kokoro", async () => {
  const dir = `/tmp/kesha-install-${Date.now()}`;
  const { exited } = spawn(
    ["bun", "bin/kesha.js", "install", "--tts"],
    { env: { ...process.env, KESHA_CACHE_DIR: dir }, stdout: "pipe", stderr: "pipe" },
  );
  expect(await exited).toBe(0);
  const { existsSync } = await import("fs");
  expect(existsSync(`${dir}/tts/kokoro-82m/model.onnx`)).toBe(true);
}, 300_000); // 5 min timeout — network download
```

Mark `.skip` by default or gate behind `RUN_NETWORK_TESTS=1`.

- [ ] **Step 5: Commit**

```bash
git add src/engine-install.ts src/cli.ts src/__tests__/engine-install.test.ts tests/integration/install.test.ts
git commit -m "feat(ts): install --tts flag triggers Kokoro download"
```

---

## Task 19: `kesha status` — show TTS section

**Files:**
- Modify: `src/status.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/status.test.ts
// Test that formatStatus renders a TTS section when voices are installed.
it("renders TTS voices", () => {
  const out = formatStatus({
    asr: { installed: true },
    tts: { engines: ["kokoro"], voices: ["en-af_heart"] },
  });
  expect(out).toMatch(/TTS/);
  expect(out).toMatch(/en-af_heart/);
});

it("hides TTS section when no voices", () => {
  const out = formatStatus({ asr: { installed: true }, tts: null });
  expect(out).not.toMatch(/TTS/);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement TTS section in `formatStatus`**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/status.ts src/__tests__/status.test.ts
git commit -m "feat(ts): show TTS section in kesha status"
```

---

## Task 20: Public API — `say()` in `src/lib.ts`

**Files:**
- Modify: `src/lib.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/lib.test.ts (extend existing)
it("exports say()", async () => {
  const { say } = await import("../lib");
  expect(typeof say).toBe("function");
});

it("exports downloadTts()", async () => {
  const { downloadTts } = await import("../lib");
  expect(typeof downloadTts).toBe("function");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Add exports**

```typescript
// src/lib.ts — append
export { say } from "./say";
export { downloadTts } from "./engine-install";
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib.ts src/__tests__/lib.test.ts
git commit -m "feat(ts): public API — say() + downloadTts()"
```

---

## Task 21: End-to-end integration test with real model

**Files:**
- Create: `tests/integration/say-e2e.test.ts`

- [ ] **Step 1: Write test**

```typescript
// tests/integration/say-e2e.test.ts
import { describe, it, expect } from "bun:test";
import { say } from "../../src/say";
import { spawn } from "bun";

const CACHE = process.env.KESHA_TEST_CACHE ?? `${process.env.HOME}/.cache/kesha`;

describe("kesha say e2e", () => {
  // Only runs if the caller has installed TTS models.
  const enabled = (await import("fs")).existsSync(`${CACHE}/tts/kokoro-82m/model.onnx`);
  if (!enabled) {
    it.skip("TTS not installed — run: kesha install --tts", () => {});
    return;
  }

  it("produces a non-silent WAV for 'Hello world'", async () => {
    const wav = await say({ text: "Hello world", voice: "en-af_heart" });
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    // Quick amplitude check: at least some sample > 0.001
    const dv = new DataView(wav.buffer, wav.byteOffset + 44); // skip RIFF+fmt+data chunks naively
    let nonZero = 0;
    for (let i = 0; i < Math.min(dv.byteLength - 4, 24000 * 4); i += 4) {
      if (Math.abs(dv.getFloat32(i, true)) > 0.001) { nonZero++; if (nonZero > 10) break; }
    }
    expect(nonZero).toBeGreaterThan(10);
  });

  it("CLI stdout is a valid WAV", async () => {
    const { stdout, exited } = spawn(
      ["bun", "bin/kesha.js", "say", "Hello"], { stdout: "pipe", stderr: "pipe" },
    );
    expect(await exited).toBe(0);
    const buf = new Uint8Array(await new Response(stdout).arrayBuffer());
    expect(new TextDecoder().decode(buf.slice(0, 4))).toBe("RIFF");
  });
});
```

- [ ] **Step 2: Run (with models installed)**

```bash
kesha install --tts    # once, manually
bun test tests/integration/say-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/say-e2e.test.ts
git commit -m "test(e2e): real model synthesis via kesha say CLI"
```

---

## Task 22: CI matrix — add TTS test job

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/actions/install-tts/action.yml` (composite, with caching)

- [ ] **Step 1: Write composite action**

```yaml
# .github/actions/install-tts/action.yml
name: Install TTS models (cached)
runs:
  using: composite
  steps:
    - uses: actions/cache@v4
      with:
        path: ~/.cache/kesha/tts
        key: kesha-tts-kokoro-v1-${{ runner.os }}
    - shell: bash
      run: bun bin/kesha.js install --tts
```

- [ ] **Step 2: Extend CI**

```yaml
# in ci.yml — add a new job
tts-e2e:
  strategy:
    matrix:
      os: [macos-14, ubuntu-24.04, windows-2022]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup-bun
    - uses: ./.github/actions/install-parakeet-backend
    - uses: ./.github/actions/install-tts
    - run: bun test tests/integration/say-e2e.test.ts
```

- [ ] **Step 3: Push + verify CI green**

```bash
git add .github/workflows/ci.yml .github/actions/install-tts/action.yml
git commit -m "ci: add tts e2e job per platform with model caching"
git push
# then: gh run watch
```

Expected: green on all three OSes.

---

## Task 23: Smoke test entry + Makefile

**Files:**
- Modify: `scripts/smoke-test.ts`
- Modify: `Makefile`

- [ ] **Step 1: Write failing smoke step**

In `scripts/smoke-test.ts` append:

```typescript
// TTS smoke
console.log("-> kesha say Hello > /tmp/kesha-smoke.wav");
const { exited } = spawn(["kesha", "say", "Hello"], { stdout: Bun.file("/tmp/kesha-smoke.wav") });
if (await exited !== 0) throw new Error("say failed");
const size = Bun.file("/tmp/kesha-smoke.wav").size;
if (size < 1000) throw new Error(`wav too small: ${size}`);
console.log(`   WAV size: ${size} bytes OK`);
```

- [ ] **Step 2: Extend Makefile**

```makefile
smoke-test-tts:
	kesha install --tts
	bun scripts/smoke-test.ts --tts

.PHONY: smoke-test-tts
```

- [ ] **Step 3: Run**

```bash
make smoke-test-tts
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-test.ts Makefile
git commit -m "test: smoke-test-tts target"
```

---

## Task 24: README + CLAUDE.md updates

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: README — add TTS section**

Insert after the existing "CLI Tools" section:

```markdown
## Text-to-Speech (preview, M1)

Kesha can also speak back — currently English only via Kokoro-82M (Russian lands in M3).

    kesha install --tts          # ~150MB download (opt-in)
    kesha say "Hello, world" > reply.wav
    echo "long text" | kesha say > reply.wav
    kesha say --out reply.wav "text"
    kesha say --voice en-af_heart "text"

Output: WAV 24kHz mono float32. Formats beyond WAV (OGG/Opus, MP3) are tracked in follow-up issues.
```

- [ ] **Step 2: CLAUDE.md — note TTS rules**

Append:

```markdown
### TTS (M1+)

- TTS models are opt-in via `kesha install --tts` — never auto-downloaded
- `kesha say` writes WAV to stdout unless `--out` is given; stderr is for progress/errors only
- English only in M1; Russian + auto-routing in M3
- `kesha-engine` uses static-linked `espeak-ng` for G2P; replacement tracked in #123
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document TTS (M1 preview)"
```

---

## Task 25: Final verification + PR

- [ ] **Step 1: Run full local suite**

```bash
cd rust && cargo test
cd .. && bun test && bunx tsc --noEmit
make smoke-test && make smoke-test-tts
```

Expected: all green.

- [ ] **Step 2: Push branch + open PR**

```bash
git push -u origin feat/bidirectional-voice-m1
gh pr create --title "feat: bidirectional voice M1 — Kokoro EN via ONNX (plumbing)" \
  --body "$(cat <<'EOF'
## Summary
- Ships `kesha say "text"` backed by Kokoro-82M ONNX with English voice `af_heart`
- Works on macOS arm64, Linux x64, Windows x64
- Opt-in install via `kesha install --tts`; default flow unchanged
- Full TDD coverage: unit (G2P, tokenizer, WAV mux, voice loader), integration (real model), e2e (CLI spawn), CI matrix

## Out of scope (tracked separately)
- FluidAudio/CoreML path (M2)
- Silero + Russian + auto-routing (M3)
- SSML (#122), ONNX G2P (#123), model mirror (#121), OGG/Opus, daemon mode

## Test plan
- [x] cargo test
- [x] bun test + bunx tsc --noEmit
- [x] make smoke-test && make smoke-test-tts
- [x] CI green on 3-OS matrix (linked run)
- [x] Manual ear-check on synthesized output

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI**

```bash
gh run watch
```

Expected: all jobs green.

- [ ] **Step 4: Self-review the diff one more time before requesting review**

---

## Self-Review (the plan writer, not the implementer)

**Spec coverage:**
- Architecture diagram → Tasks 2, 8, 10, 15, 16 (TS + Rust split)
- CLI surface (`say`, `--voice`, `--lang`, `--out`, `--rate`, `--list-voices`, stdin) → Tasks 10, 15, 16
- Voice routing (explicit + default `en-af_heart`) → Task 14
- Install flow (opt-in `--tts`) → Tasks 12, 13, 18
- Storage layout (`~/.cache/kesha/tts/`) → Tasks 12, 14, 17
- Error taxonomy + exit codes → Task 11
- Data flow → End-to-end confirmed by Tasks 9, 21
- Testing strategy → Every task has tests; Task 21 is the e2e
- CI matrix → Task 22
- Smoke → Task 23
- Docs → Task 24
- Public API → Task 20

Gaps: Auto-routing via `NLLanguageRecognizer` is M3 per spec — correctly deferred. FluidAudio/CoreML path is M2 — correctly deferred. WAV-only output — v1 scope. No gaps.

**Placeholder scan:** The two spike tasks explicitly flag `<crate>@<version>` placeholders to be resolved during Task 0.1 — that is the spike's purpose, not a plan gap. Every implementation task has complete code. No TBD/TODO in any implementation task.

**Type consistency:** `TtsError` variants named once in Task 2 match usage in Tasks 9, 11, 14. `SayOptions` is consistent between Rust (`rust/src/tts/mod.rs`) and TS (`src/say.ts`). `resolve_voice` return type matches consumers.
