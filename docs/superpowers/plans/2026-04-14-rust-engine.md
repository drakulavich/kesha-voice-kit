# Rust Engine Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `parakeet-engine`, a Rust binary that handles all inference (ASR + lang-id) with `fluidaudio-rs` on macOS and `ort` on Linux/Windows.

**Architecture:** Single Rust project with Cargo features for conditional compilation. `fluidaudio-rs` (CoreML/ANE) on macOS arm64, `ort` (ONNX Runtime) on other platforms. Invoked as subprocess by the TypeScript CLI. Audio decoding via `symphonia` + `rubato`.

**Tech Stack:** Rust, fluidaudio-rs, ort, symphonia, rubato, clap, serde_json, objc2

**Spec:** `docs/superpowers/specs/2026-04-14-rust-engine-design.md`

**Note:** This is Plan A (Rust Engine). Plan B (TypeScript Migration) follows separately after this binary is working.

---

## File Structure

```
rust/
├── Cargo.toml
├── src/
│   ├── main.rs           # CLI entry: clap subcommands, dispatch
│   ├── audio.rs          # Audio loading + resampling (symphonia + rubato)
│   ├── transcribe.rs     # ASR: delegates to backend
│   ├── lang_id.rs        # Audio lang-id: ECAPA-TDNN via ort (all platforms)
│   ├── text_lang.rs      # Text lang-id: NLLanguageRecognizer (macOS) or noop
│   ├── models.rs         # Model download + cache paths
│   ├── capabilities.rs   # --capabilities-json output
│   └── backend/
│       ├── mod.rs         # TranscribeBackend trait + factory
│       ├── fluidaudio.rs  # macOS: fluidaudio-rs
│       └── onnx.rs        # Linux/Windows: ort ONNX pipeline
```

---

### Task 1: Scaffold Rust Project

**Files:**
- Create: `rust/Cargo.toml`
- Create: `rust/src/main.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "parakeet-engine"
version = "1.0.0"
edition = "2021"
description = "Inference engine for parakeet-cli: ASR + language detection"

[features]
default = ["onnx"]
coreml = ["dep:fluidaudio-rs"]
onnx = ["dep:ort"]

[dependencies]
clap = { version = "4", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"

# Audio decoding
symphonia = { version = "0.5", features = ["mp3", "ogg", "flac", "aac", "pcm", "wav"] }
rubato = "0.16"

# ONNX backend (Linux/Windows)
ort = { version = "2", optional = true }
ndarray = { version = "0.16", optional = true }

# CoreML backend (macOS)
fluidaudio-rs = { version = "0.1", optional = true }

[dependencies.ort]
version = "2"
optional = true

[profile.release]
lto = true
strip = true
```

Note: The `ort` and `ndarray` versions should be verified against the latest crates.io at implementation time. `fluidaudio-rs` version should match what's on crates.io.

- [ ] **Step 2: Create main.rs with clap skeleton**

```rust
use clap::{Parser, Subcommand};
use anyhow::Result;

#[derive(Parser)]
#[command(name = "parakeet-engine", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Print capabilities as JSON
    #[arg(long = "capabilities-json")]
    capabilities_json: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Transcribe an audio file
    Transcribe {
        /// Path to audio file
        audio_path: String,
    },
    /// Detect spoken language from audio
    DetectLang {
        /// Path to audio file
        audio_path: String,
    },
    /// Detect language of text (macOS only)
    DetectTextLang {
        /// Text to analyze
        text: String,
    },
    /// Download models
    Install {
        /// Re-download even if cached
        #[arg(long)]
        no_cache: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.capabilities_json {
        println!("{}", serde_json::json!({
            "protocolVersion": 2,
            "backend": backend_name(),
            "features": supported_features()
        }));
        return Ok(());
    }

    match cli.command {
        Some(Commands::Transcribe { audio_path }) => {
            eprintln!("TODO: transcribe {}", audio_path);
        }
        Some(Commands::DetectLang { audio_path }) => {
            eprintln!("TODO: detect-lang {}", audio_path);
        }
        Some(Commands::DetectTextLang { text }) => {
            eprintln!("TODO: detect-text-lang {}", text);
        }
        Some(Commands::Install { no_cache }) => {
            eprintln!("TODO: install (no_cache={})", no_cache);
        }
        None => {
            eprintln!("Usage: parakeet-engine <command>");
            eprintln!("Run --help for usage information");
            std::process::exit(1);
        }
    }

    Ok(())
}

fn backend_name() -> &'static str {
    #[cfg(feature = "coreml")]
    { "coreml" }
    #[cfg(not(feature = "coreml"))]
    { "onnx" }
}

fn supported_features() -> Vec<&'static str> {
    let mut features = vec!["transcribe", "detect-lang"];
    #[cfg(target_os = "macos")]
    features.push("detect-text-lang");
    features
}
```

- [ ] **Step 3: Verify it builds**

```bash
cd rust && cargo build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 4: Verify CLI works**

```bash
cargo run -- --capabilities-json
```

Expected: `{"backend":"onnx","features":["transcribe","detect-lang"],"protocolVersion":2}`

```bash
cargo run -- transcribe test.wav
```

Expected: `TODO: transcribe test.wav`

- [ ] **Step 5: Commit**

```bash
git add rust/
git commit -m "feat(engine): scaffold Rust project with clap CLI skeleton"
```

---

### Task 2: Audio Loading Module

**Files:**
- Create: `rust/src/audio.rs`
- Modify: `rust/src/main.rs` (add `mod audio;`)

- [ ] **Step 1: Create audio.rs**

```rust
use anyhow::{Context, Result};
use rubato::{SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use std::fs::File;
use std::path::Path;

const TARGET_SAMPLE_RATE: u32 = 16000;

/// Load an audio file and return 16kHz mono f32 samples.
pub fn load_audio(path: &str) -> Result<Vec<f32>> {
    let file = File::open(path).with_context(|| format!("file not found: {}", path))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .with_context(|| format!("unsupported audio format: {}", path))?;

    let mut format = probed.format;
    let track = format.default_track()
        .context("no audio track found")?;
    let sample_rate = track.codec_params.sample_rate
        .context("unknown sample rate")?;
    let channels = track.codec_params.channels
        .map(|c| c.count())
        .unwrap_or(1);
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("unsupported audio codec")?;

    let mut all_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder.decode(&packet)?;
        let spec = *decoded.spec();
        let num_frames = decoded.frames();

        let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        let samples = sample_buf.samples();

        // Mix to mono if multi-channel
        if channels > 1 {
            for frame in 0..num_frames {
                let mut sum = 0.0f32;
                for ch in 0..channels {
                    sum += samples[frame * channels + ch];
                }
                all_samples.push(sum / channels as f32);
            }
        } else {
            all_samples.extend_from_slice(samples);
        }
    }

    // Resample to 16kHz if needed
    if sample_rate != TARGET_SAMPLE_RATE {
        all_samples = resample(&all_samples, sample_rate, TARGET_SAMPLE_RATE)?;
    }

    Ok(all_samples)
}

fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>> {
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(
        to_rate as f64 / from_rate as f64,
        2.0,
        params,
        samples.len(),
        1, // mono
    )?;

    let input = vec![samples.to_vec()];
    let output = resampler.process(&input, None)?;
    Ok(output.into_iter().next().unwrap_or_default())
}

/// Load audio and truncate to max_seconds (for lang-id).
pub fn load_audio_truncated(path: &str, max_seconds: f32) -> Result<Vec<f32>> {
    let samples = load_audio(path)?;
    let max_samples = (max_seconds * TARGET_SAMPLE_RATE as f32) as usize;
    if samples.len() > max_samples {
        Ok(samples[..max_samples].to_vec())
    } else {
        Ok(samples)
    }
}
```

- [ ] **Step 2: Add module to main.rs**

Add `mod audio;` at the top of `main.rs`.

- [ ] **Step 3: Build and verify**

```bash
cd rust && cargo build 2>&1 | tail -5
```

Expected: Build succeeds. Note: symphonia version and API may differ slightly — adjust imports if needed.

- [ ] **Step 4: Commit**

```bash
git add rust/src/audio.rs rust/src/main.rs
git commit -m "feat(engine): add audio loading module (symphonia + rubato)"
```

---

### Task 3: Backend Trait and ONNX Backend

**Files:**
- Create: `rust/src/backend/mod.rs`
- Create: `rust/src/backend/onnx.rs`
- Modify: `rust/src/main.rs` (add `mod backend;`)

- [ ] **Step 1: Create backend trait**

```rust
// rust/src/backend/mod.rs
use anyhow::Result;

#[cfg(feature = "coreml")]
pub mod fluidaudio;
#[cfg(feature = "onnx")]
pub mod onnx;

pub trait TranscribeBackend {
    fn transcribe(&self, audio_samples: &[f32]) -> Result<String>;
}

pub fn create_backend(model_dir: &str) -> Result<Box<dyn TranscribeBackend>> {
    #[cfg(feature = "coreml")]
    {
        Ok(Box::new(fluidaudio::FluidAudioBackend::new()?))
    }
    #[cfg(not(feature = "coreml"))]
    {
        Ok(Box::new(onnx::OnnxBackend::new(model_dir)?))
    }
}
```

- [ ] **Step 2: Create ONNX backend**

```rust
// rust/src/backend/onnx.rs
use anyhow::{Context, Result};
use ort::session::Session;
use std::path::Path;

use super::TranscribeBackend;

pub struct OnnxBackend {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
}

impl OnnxBackend {
    pub fn new(model_dir: &str) -> Result<Self> {
        let dir = Path::new(model_dir);

        let preprocessor = Session::builder()?
            .commit_from_file(dir.join("nemo128.onnx"))
            .context("failed to load preprocessor model")?;

        let encoder = Session::builder()?
            .commit_from_file(dir.join("encoder-model.onnx"))
            .context("failed to load encoder model")?;

        let decoder = Session::builder()?
            .commit_from_file(dir.join("decoder_joint-model.onnx"))
            .context("failed to load decoder model")?;

        let vocab_path = dir.join("vocab.txt");
        let vocab_text = std::fs::read_to_string(&vocab_path)
            .with_context(|| format!("failed to read vocab: {}", vocab_path.display()))?;
        let vocab: Vec<String> = vocab_text.lines().map(|l| l.to_string()).collect();

        Ok(Self { preprocessor, encoder, decoder, vocab })
    }
}

impl TranscribeBackend for OnnxBackend {
    fn transcribe(&self, audio_samples: &[f32]) -> Result<String> {
        // Step 1: Preprocess — mel spectrogram
        let input_len = audio_samples.len();
        let waveform = ort::value::Tensor::from_array(
            ndarray::Array2::from_shape_vec((1, input_len), audio_samples.to_vec())?
        )?;
        let lengths = ort::value::Tensor::from_array(
            ndarray::Array1::from_vec(vec![input_len as i64])
        )?;

        let pre_outputs = self.preprocessor.run(
            ort::inputs!["waveforms" => waveform, "waveforms_lens" => lengths]?
        )?;

        let features = pre_outputs["features"].extract_tensor::<f32>()?;
        let features_lens = pre_outputs["features_lens"].extract_tensor::<i64>()?;

        // Step 2: Encode
        let enc_outputs = self.encoder.run(
            ort::inputs!["audio_signal" => features.view(), "length" => features_lens.view()]?
        )?;

        let encoded = enc_outputs["logits"].extract_tensor::<f32>()?;
        let encoded_lens = enc_outputs["encoded_lengths"].extract_tensor::<i64>()?;
        let actual_len = encoded_lens.view()[[0]] as usize;

        // Step 3: Decode (greedy for now — beam search can come later)
        let encoded_view = encoded.view();
        let dims = encoded_view.shape();
        let d = dims[1];
        let t = dims[2];

        // Transpose [1, D, T] -> iterate over T frames
        let blank_id = self.vocab.len() - 1;
        let mut tokens: Vec<usize> = Vec::new();

        // Simple greedy decode over encoder output
        // Full RNN-T beam search would be more accurate but much more complex
        // For now, use CTC-style greedy decode on the encoder logits
        for frame in 0..actual_len.min(t) {
            let mut best_id = 0;
            let mut best_val = f32::NEG_INFINITY;
            for j in 0..d {
                let val = encoded_view[[0, j, frame]];
                if val > best_val {
                    best_val = val;
                    best_id = j;
                }
            }
            if best_id != blank_id {
                if tokens.last() != Some(&best_id) {
                    tokens.push(best_id);
                }
            }
        }

        // Detokenize
        let text: String = tokens.iter()
            .filter_map(|&id| self.vocab.get(id))
            .map(|t| t.replace('\u{2581}', " "))
            .collect::<String>()
            .trim()
            .to_string();

        Ok(text)
    }
}
```

**Note:** This uses a simplified greedy CTC-style decoder. The existing TypeScript implementation uses full RNN-T beam search with the `decoder_joint-model.onnx`. The proper RNN-T decoder should be ported in a follow-up task, but greedy decoding works for initial validation. The ONNX session input/output names must be verified against the actual model — they may differ from the placeholder names used here.

- [ ] **Step 3: Add module to main.rs**

Add `mod backend;` at the top of `main.rs`.

- [ ] **Step 4: Build and verify**

```bash
cd rust && cargo build --features onnx 2>&1 | tail -10
```

Expected: Build succeeds (or minor API adjustments needed for ort version).

- [ ] **Step 5: Commit**

```bash
git add rust/src/backend/
git commit -m "feat(engine): add backend trait and ONNX backend (greedy decoder)"
```

---

### Task 4: FluidAudio Backend (macOS)

**Files:**
- Create: `rust/src/backend/fluidaudio.rs`

- [ ] **Step 1: Create FluidAudio backend**

```rust
// rust/src/backend/fluidaudio.rs
use anyhow::Result;
use fluidaudio_rs::FluidAudio;

use super::TranscribeBackend;

pub struct FluidAudioBackend {
    audio: FluidAudio,
}

impl FluidAudioBackend {
    pub fn new() -> Result<Self> {
        let audio = FluidAudio::new()?;
        audio.init_asr()?;
        Ok(Self { audio })
    }
}

impl TranscribeBackend for FluidAudioBackend {
    fn transcribe(&self, _audio_samples: &[f32]) -> Result<String> {
        // fluidaudio-rs handles audio loading internally
        // This will be called with a file path via a separate method
        anyhow::bail!("FluidAudioBackend::transcribe requires a file path — use transcribe_file instead")
    }
}

impl FluidAudioBackend {
    pub fn transcribe_file(&self, path: &str) -> Result<String> {
        let result = self.audio.transcribe_file(path)?;
        Ok(result.text)
    }
}
```

**Note:** `fluidaudio-rs` handles its own audio loading and model management. The `TranscribeBackend` trait's `transcribe(&[f32])` method doesn't fit perfectly since FluidAudio expects a file path. The trait and `transcribe.rs` will need to accommodate both patterns. Verify the `fluidaudio-rs` API at implementation time — it may accept raw samples too.

- [ ] **Step 2: Build on macOS**

```bash
cd rust && cargo build --features coreml 2>&1 | tail -10
```

Expected: Build succeeds on macOS with Xcode installed. Will fail on Linux (expected).

- [ ] **Step 3: Commit**

```bash
git add rust/src/backend/fluidaudio.rs
git commit -m "feat(engine): add FluidAudio backend for macOS CoreML"
```

---

### Task 5: Transcribe Subcommand

**Files:**
- Create: `rust/src/transcribe.rs`
- Modify: `rust/src/main.rs` (wire up `transcribe` command)

- [ ] **Step 1: Create transcribe.rs**

```rust
use anyhow::Result;

use crate::audio;
use crate::backend;
use crate::models;

pub fn transcribe(audio_path: &str) -> Result<String> {
    #[cfg(feature = "coreml")]
    {
        let be = backend::fluidaudio::FluidAudioBackend::new()?;
        return be.transcribe_file(audio_path);
    }

    #[cfg(not(feature = "coreml"))]
    {
        let model_dir = models::asr_model_dir();
        if !models::is_asr_cached(&model_dir) {
            anyhow::bail!(
                "Error: No transcription models installed\n\n\
                 Please run: parakeet install"
            );
        }
        let be = backend::onnx::OnnxBackend::new(&model_dir)?;
        let samples = audio::load_audio(audio_path)?;
        be.transcribe(&samples)
    }
}
```

- [ ] **Step 2: Wire up in main.rs**

Replace the `Commands::Transcribe` match arm:

```rust
Some(Commands::Transcribe { audio_path }) => {
    let text = transcribe::transcribe(&audio_path)?;
    println!("{}", text);
}
```

Add `mod transcribe;` at the top.

- [ ] **Step 3: Build**

```bash
cd rust && cargo build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add rust/src/transcribe.rs rust/src/main.rs
git commit -m "feat(engine): wire up transcribe subcommand"
```

---

### Task 6: Model Management

**Files:**
- Create: `rust/src/models.rs`

- [ ] **Step 1: Create models.rs**

```rust
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

const ASR_HF_REPO: &str = "istupakov/parakeet-tdt-0.6b-v3-onnx";
const ASR_FILES: &[&str] = &[
    "encoder-model.onnx",
    "encoder-model.onnx.data",
    "decoder_joint-model.onnx",
    "nemo128.onnx",
    "vocab.txt",
];

const LANG_ID_HF_REPO: &str = "drakulavich/SpeechBrain-coreml";
const LANG_ID_FILES: &[&str] = &[
    "lang-id-ecapa.onnx",
    "lang-id-ecapa.onnx.data",
    "labels.json",
];

fn cache_dir() -> PathBuf {
    let home = dirs::home_dir().expect("cannot determine home directory");
    home.join(".cache").join("parakeet")
}

pub fn asr_model_dir() -> String {
    cache_dir().join("models").join("parakeet-tdt-v3").to_string_lossy().to_string()
}

pub fn lang_id_model_dir() -> String {
    cache_dir().join("models").join("lang-id-ecapa").to_string_lossy().to_string()
}

pub fn is_asr_cached(dir: &str) -> bool {
    ASR_FILES.iter().all(|f| Path::new(dir).join(f).exists())
}

pub fn is_lang_id_cached(dir: &str) -> bool {
    LANG_ID_FILES.iter().all(|f| Path::new(dir).join(f).exists())
}

pub fn install(no_cache: bool) -> Result<()> {
    #[cfg(feature = "coreml")]
    {
        eprintln!("Downloading CoreML models...");
        let audio = fluidaudio_rs::FluidAudio::new()?;
        audio.init_asr()?;
        eprintln!("CoreML models ready.");
    }

    #[cfg(not(feature = "coreml"))]
    {
        let asr_dir = asr_model_dir();
        if no_cache || !is_asr_cached(&asr_dir) {
            download_hf_files(ASR_HF_REPO, ASR_FILES, &asr_dir)?;
            eprintln!("ASR models downloaded.");
        } else {
            eprintln!("ASR models already cached.");
        }
    }

    let lang_id_dir = lang_id_model_dir();
    if no_cache || !is_lang_id_cached(&lang_id_dir) {
        download_hf_files(LANG_ID_HF_REPO, LANG_ID_FILES, &lang_id_dir)?;
        eprintln!("Lang-ID models downloaded.");
    } else {
        eprintln!("Lang-ID models already cached.");
    }

    // Legacy cleanup
    cleanup_legacy();

    Ok(())
}

fn download_hf_files(repo: &str, files: &[&str], dest_dir: &str) -> Result<()> {
    fs::create_dir_all(dest_dir)?;

    for file in files {
        let url = format!("https://huggingface.co/{}/resolve/main/{}", repo, file);
        let dest = Path::new(dest_dir).join(file);

        eprintln!("Downloading {}...", file);

        let response = ureq::get(&url)
            .call()
            .with_context(|| format!("failed to download {}", file))?;

        let mut reader = response.into_reader();
        let mut out = fs::File::create(&dest)
            .with_context(|| format!("failed to create {}", dest.display()))?;
        std::io::copy(&mut reader, &mut out)?;
    }

    Ok(())
}

fn cleanup_legacy() {
    let cache = cache_dir();

    // Old ONNX model directory
    let old_onnx = cache.join("v3");
    if old_onnx.exists() {
        eprintln!("Cleaning up legacy ONNX models...");
        let _ = fs::remove_dir_all(&old_onnx);
    }

    // Old Swift binary
    let old_swift = cache.join("coreml").join("bin").join("parakeet-coreml");
    if old_swift.exists() {
        eprintln!("Cleaning up legacy CoreML binary...");
        let _ = fs::remove_file(&old_swift);
    }
}
```

**Note:** Add `ureq = "3"` and `dirs = "6"` to `Cargo.toml` dependencies.

- [ ] **Step 2: Wire up in main.rs**

Replace the `Commands::Install` match arm:

```rust
Some(Commands::Install { no_cache }) => {
    models::install(no_cache)?;
    eprintln!("Install complete.");
}
```

Add `mod models;` at the top.

- [ ] **Step 3: Build**

```bash
cd rust && cargo build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add rust/src/models.rs rust/Cargo.toml rust/src/main.rs
git commit -m "feat(engine): add model download and cache management"
```

---

### Task 7: Lang-ID (Audio)

**Files:**
- Create: `rust/src/lang_id.rs`
- Modify: `rust/src/main.rs` (wire up `detect-lang`)

- [ ] **Step 1: Create lang_id.rs**

```rust
use anyhow::{Context, Result};
use ort::session::Session;
use serde::Serialize;
use std::path::Path;

use crate::audio;
use crate::models;

#[derive(Serialize)]
pub struct LangDetectResult {
    pub code: String,
    pub confidence: f32,
}

const MAX_SECONDS: f32 = 10.0;

pub fn detect_audio_language(audio_path: &str) -> Result<LangDetectResult> {
    let model_dir = models::lang_id_model_dir();
    if !models::is_lang_id_cached(&model_dir) {
        anyhow::bail!("Lang-ID model not installed. Run: parakeet install");
    }

    let dir = Path::new(&model_dir);

    let session = Session::builder()?
        .commit_from_file(dir.join("lang-id-ecapa.onnx"))
        .context("failed to load lang-id model")?;

    let labels: Vec<String> = {
        let data = std::fs::read_to_string(dir.join("labels.json"))?;
        serde_json::from_str(&data)?
    };

    let samples = audio::load_audio_truncated(audio_path, MAX_SECONDS)?;

    let input_len = samples.len();
    let waveform = ort::value::Tensor::from_array(
        ndarray::Array2::from_shape_vec((1, input_len), samples)?
    )?;

    let outputs = session.run(ort::inputs!["waveform" => waveform]?)?;
    let probs = outputs["language_probs"].extract_tensor::<f32>()?;
    let probs_view = probs.view();

    let mut best_idx = 0;
    let mut best_val = f32::NEG_INFINITY;
    for (i, &val) in probs_view.iter().enumerate() {
        if val > best_val {
            best_val = val;
            best_idx = i;
        }
    }

    Ok(LangDetectResult {
        code: labels.get(best_idx).cloned().unwrap_or_default(),
        confidence: best_val,
    })
}
```

- [ ] **Step 2: Wire up in main.rs**

Replace the `Commands::DetectLang` match arm:

```rust
Some(Commands::DetectLang { audio_path }) => {
    let result = lang_id::detect_audio_language(&audio_path)?;
    println!("{}", serde_json::to_string(&result)?);
}
```

Add `mod lang_id;` at the top.

- [ ] **Step 3: Build**

```bash
cd rust && cargo build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add rust/src/lang_id.rs rust/src/main.rs
git commit -m "feat(engine): add audio language detection (ECAPA-TDNN)"
```

---

### Task 8: Text Lang-ID (macOS only)

**Files:**
- Create: `rust/src/text_lang.rs`
- Modify: `rust/src/main.rs` (wire up `detect-text-lang`)

- [ ] **Step 1: Create text_lang.rs**

```rust
use anyhow::Result;
use serde::Serialize;

#[derive(Serialize)]
pub struct TextLangResult {
    pub code: String,
    pub confidence: f64,
}

#[cfg(target_os = "macos")]
pub fn detect_text_language(text: &str) -> Result<TextLangResult> {
    use std::process::Command;

    // Use swift CLI to call NLLanguageRecognizer — avoids objc2 complexity
    // This is a pragmatic approach; a pure objc2 binding would be faster
    let output = Command::new("swift")
        .arg("-e")
        .arg(format!(
            r#"
            import NaturalLanguage
            import Foundation
            let r = NLLanguageRecognizer()
            r.processString("{text}")
            var code = ""
            var conf = 0.0
            if let lang = r.dominantLanguage {{
                code = lang.rawValue
                conf = r.languageHypotheses(withMaximum: 1)[lang] ?? 0.0
            }}
            let d = try! JSONSerialization.data(withJSONObject: ["code": code, "confidence": conf], options: [.sortedKeys])
            FileHandle.standardOutput.write(d)
            "#,
            text = text.replace('"', r#"\""#).replace('\n', " ")
        ))
        .output()?;

    if !output.status.success() {
        anyhow::bail!("NLLanguageRecognizer failed");
    }

    let result: TextLangResult = serde_json::from_slice(&output.stdout)?;
    Ok(result)
}

#[cfg(not(target_os = "macos"))]
pub fn detect_text_language(_text: &str) -> Result<TextLangResult> {
    anyhow::bail!("detect-text-lang is only available on macOS")
}
```

**Note:** This uses a `swift -e` inline script as a pragmatic approach. A proper implementation would use `objc2` crate to call `NLLanguageRecognizer` directly, which would be faster (no subprocess). This can be optimized later. The text escaping handles quotes and newlines to prevent injection.

- [ ] **Step 2: Wire up in main.rs**

Replace the `Commands::DetectTextLang` match arm:

```rust
Some(Commands::DetectTextLang { text }) => {
    let result = text_lang::detect_text_language(&text)?;
    println!("{}", serde_json::to_string(&result)?);
}
```

Add `mod text_lang;` at the top.

- [ ] **Step 3: Build**

```bash
cd rust && cargo build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add rust/src/text_lang.rs rust/src/main.rs
git commit -m "feat(engine): add text language detection (macOS NLLanguageRecognizer)"
```

---

### Task 9: Capabilities JSON

**Files:**
- Create: `rust/src/capabilities.rs`
- Modify: `rust/src/main.rs` (extract capabilities logic)

- [ ] **Step 1: Create capabilities.rs**

```rust
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub protocol_version: u32,
    pub backend: &'static str,
    pub features: Vec<&'static str>,
}

pub fn get_capabilities() -> Capabilities {
    let mut features = vec!["transcribe", "detect-lang"];

    #[cfg(target_os = "macos")]
    features.push("detect-text-lang");

    Capabilities {
        protocol_version: 2,
        backend: backend_name(),
        features,
    }
}

fn backend_name() -> &'static str {
    #[cfg(feature = "coreml")]
    { "coreml" }
    #[cfg(not(feature = "coreml"))]
    { "onnx" }
}
```

- [ ] **Step 2: Update main.rs to use capabilities module**

Replace the `capabilities_json` handler and remove the inline `backend_name`/`supported_features` functions:

```rust
if cli.capabilities_json {
    let caps = capabilities::get_capabilities();
    println!("{}", serde_json::to_string(&caps)?);
    return Ok(());
}
```

Add `mod capabilities;` at the top.

- [ ] **Step 3: Build and test**

```bash
cd rust && cargo run -- --capabilities-json
```

Expected: `{"protocolVersion":2,"backend":"onnx","features":["transcribe","detect-lang"]}`

- [ ] **Step 4: Commit**

```bash
git add rust/src/capabilities.rs rust/src/main.rs
git commit -m "feat(engine): extract capabilities module"
```

---

### Task 10: CI Workflow

**Files:**
- Create: `.github/workflows/build-engine.yml`
- Create: `.github/workflows/rust-test.yml`

- [ ] **Step 1: Create build-engine.yml**

```yaml
name: "\U0001F528 Build Engine"

on:
  push:
    tags: ["v*"]

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-14
            target: aarch64-apple-darwin
            features: coreml
            binary: parakeet-engine-darwin-arm64
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            features: onnx
            binary: parakeet-engine-linux-x64
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            features: onnx
            binary: parakeet-engine-windows-x64.exe
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: rust
      - name: Build release binary
        run: |
          cd rust
          cargo build --release --target ${{ matrix.target }} --features ${{ matrix.features }} --no-default-features
      - name: Prepare artifact
        shell: bash
        run: |
          src="rust/target/${{ matrix.target }}/release/parakeet-engine"
          if [ "${{ matrix.os }}" = "windows-latest" ]; then
            src="${src}.exe"
          fi
          cp "$src" "${{ matrix.binary }}"
      - name: Upload to release
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ matrix.binary }}
```

- [ ] **Step 2: Create rust-test.yml**

```yaml
name: "\U0001F9EA Rust Tests"

on:
  pull_request:
    paths: ["rust/**"]

jobs:
  test:
    strategy:
      matrix:
        include:
          - os: macos-14
            features: coreml
          - os: ubuntu-latest
            features: onnx
          - os: windows-latest
            features: onnx
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: rust
      - name: Run tests
        run: |
          cd rust
          cargo test --features ${{ matrix.features }} --no-default-features
      - name: Check formatting
        run: |
          cd rust
          cargo fmt -- --check
      - name: Clippy
        run: |
          cd rust
          cargo clippy --features ${{ matrix.features }} --no-default-features -- -D warnings
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-engine.yml .github/workflows/rust-test.yml
git commit -m "ci: add Rust engine build and test workflows"
```

---

### Task 11: Integration Test

**Files:**
- No new files — test the assembled binary

- [ ] **Step 1: Build release binary**

```bash
cd rust && cargo build --release 2>&1 | tail -5
```

- [ ] **Step 2: Test capabilities**

```bash
./target/release/parakeet-engine --capabilities-json
```

Expected: Valid JSON with `protocolVersion: 2`.

- [ ] **Step 3: Test install**

```bash
./target/release/parakeet-engine install
```

Expected: Downloads models (or reports cached).

- [ ] **Step 4: Test transcription (if models downloaded)**

```bash
./target/release/parakeet-engine transcribe ../fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg
```

Expected: Russian transcript on stdout.

- [ ] **Step 5: Test lang-id**

```bash
./target/release/parakeet-engine detect-lang ../fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg
```

Expected: `{"code":"ru","confidence":0.9...}`

- [ ] **Step 6: Test text lang-id (macOS only)**

```bash
./target/release/parakeet-engine detect-text-lang "Привет мир"
```

Expected: `{"code":"ru","confidence":0.9...}`

- [ ] **Step 7: Commit any fixes**

```bash
git add -A && git commit -m "fix: address integration test findings"
```
