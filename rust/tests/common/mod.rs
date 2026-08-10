//! Shared helpers for the integration tests under `rust/tests/*.rs`.
//!
//! Cargo compiles each `tests/*.rs` into its own test binary, and treats
//! `tests/<name>.rs` as one of those binaries — so this module lives at
//! `tests/common/mod.rs` (not `tests/common.rs`) to avoid being built as
//! a standalone test target.
//!
//! Each test file opts in via `mod common;` at its top. Not every file
//! uses every helper, so `#![allow(dead_code)]` keeps the per-binary
//! `unused` lint quiet without wrapping each helper individually.

#![allow(dead_code)]

use std::path::PathBuf;

use hound::SampleFormat;

/// Path to the freshly-built `kesha-engine` binary as embedded by cargo via
/// `env!("CARGO_BIN_EXE_kesha-engine")`. Use directly with
/// [`std::process::Command::new`] — `Command::new` accepts `&str`.
pub fn engine_bin() -> &'static str {
    env!("CARGO_BIN_EXE_kesha-engine")
}

/// Parse a WAV buffer with `hound`: returns `(sample_rate, channels, f32_samples)`.
/// Panics on malformed input so failures surface as assertion errors.
pub fn parse_wav(wav: &[u8]) -> (u32, u16, Vec<f32>) {
    let cursor = std::io::Cursor::new(wav);
    let mut reader = hound::WavReader::new(cursor).expect("WAV bytes must be parseable by hound");
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .expect("f32 sample read"),
        SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<Vec<_>, _>>()
                .expect("int→f32 sample conversion")
        }
    };
    (spec.sample_rate, spec.channels, samples)
}

/// RMS amplitude of a sample slice (0.0 for empty).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Assert `wav` is a real 24 kHz mono Kokoro speech buffer — correct header,
/// no clipping, and non-silent RMS — then return the decoded samples so callers
/// can add per-test assertions (duration, silence gaps). `ctx` labels failures.
///
/// A header-plus-length check (the historical oracle) passes on a well-formed
/// but silent/garbage WAV; this asserts the bytes are actual audible speech.
pub fn assert_kokoro_speech(wav: &[u8], ctx: &str) -> Vec<f32> {
    assert!(wav.len() >= 4 && &wav[..4] == b"RIFF", "{ctx}: not a WAV");
    let (sample_rate, channels, samples) = parse_wav(wav);
    assert_eq!(
        sample_rate, 24_000,
        "{ctx}: expected 24000 Hz, got {sample_rate}"
    );
    assert_eq!(channels, 1, "{ctx}: expected mono, got {channels} channels");
    assert!(!samples.is_empty(), "{ctx}: no samples");
    for (i, &s) in samples.iter().enumerate() {
        assert!(
            (-1.0..=1.0).contains(&s),
            "{ctx}: clipping at sample {i}: {s}"
        );
    }
    let r = rms(&samples);
    assert!(r > 0.01, "{ctx}: near-silent (RMS={r:.4})");
    samples
}

/// True when the lane promised to stage models, so a missing one must fail the
/// run rather than skip. Every gate below returns `None` on a missing model and
/// its callers return early, which nextest reports as a pass — so a lane whose
/// layout stopped matching what the gates read goes green having run nothing
/// (#741). CI lanes that stage models set `KESHA_REQUIRE_MODEL_TESTS`.
pub fn missing_model_is_fatal(flag: Option<&str>) -> bool {
    !matches!(flag, None | Some("") | Some("0"))
}

pub fn models_required() -> bool {
    missing_model_is_fatal(std::env::var("KESHA_REQUIRE_MODEL_TESTS").ok().as_deref())
}

/// `KOKORO_MODEL` + `KOKORO_VOICE` env-var skip gate.
///
/// Returns `Some((model, voice))` when both vars are set, `None` otherwise.
/// The historical pattern: tests that need a real Kokoro model + voice file
/// skip silently on CI runs that don't stage them. Callers print the skip
/// reason themselves so each test owns its own message.
pub fn kokoro_paths_or_skip() -> Option<(String, String)> {
    if let (Ok(m), Ok(v)) = (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        return Some((m, v));
    }
    assert!(
        !models_required(),
        "KOKORO_MODEL/KOKORO_VOICE unset while KESHA_REQUIRE_MODEL_TESTS is set — \
         this lane stages models, so skipping here would be a green run of nothing (#741)"
    );
    None
}

/// Cache-based skip gate for Kokoro: returns the cache base
/// (`KESHA_CACHE_DIR` if set, else `~/.cache/kesha`) when both
/// `models/kokoro-82m/model.onnx` and the default male voice
/// `models/kokoro-82m/voices/am_michael.bin` are present. Returns
/// `None` otherwise.
///
/// Default voice is the male `am_michael` per CLAUDE.md
/// "DEFAULT TTS VOICES MUST BE MALE".
pub fn kokoro_cache_dir_or_skip() -> Option<PathBuf> {
    let base = cache_base();
    let model = base.join("models/kokoro-82m/model.onnx");
    let voice = base.join("models/kokoro-82m/voices/am_michael.bin");
    if model.exists() && voice.exists() {
        return Some(base);
    }
    assert!(
        !models_required(),
        "no Kokoro runtime layout under {} while KESHA_REQUIRE_MODEL_TESTS is set — \
         this lane stages models, so skipping here would be a green run of nothing (#741)",
        base.display()
    );
    None
}

/// Kokoro graph + `voice_name`'s pack under `cache`, or `None` when either is
/// absent. Same policy as the gates above: a lane that promised models fails.
pub fn kokoro_voice_or_skip(
    cache: &std::path::Path,
    voice_name: &str,
) -> Option<(PathBuf, PathBuf)> {
    let model = cache.join("models/kokoro-82m/model.onnx");
    let voice = cache
        .join("models/kokoro-82m/voices")
        .join(format!("{voice_name}.bin"));
    if model.exists() && voice.exists() {
        return Some((model, voice));
    }
    assert!(
        !models_required(),
        "Kokoro graph or voice {voice_name} missing under {} while \
         KESHA_REQUIRE_MODEL_TESTS is set — this lane stages the voice packs, so \
         skipping here would be a green run of nothing (#741)",
        cache.display()
    );
    None
}

/// Resolve the cache base used by every cache-based skip gate.
/// `KESHA_CACHE_DIR` if set, else `$HOME/.cache/kesha`. Falls back to
/// `/tmp/.cache/kesha` if `HOME` is unset (matches the historical
/// behaviour of the per-test helpers we're replacing).
fn cache_base() -> PathBuf {
    if let Ok(dir) = std::env::var("KESHA_CACHE_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".cache/kesha")
}
