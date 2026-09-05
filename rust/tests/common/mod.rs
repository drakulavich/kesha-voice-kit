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

use std::path::{Path, PathBuf};

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

/// Which weights a lane promised to stage, if any.
///
/// Every gate below returns `None` on a missing model and its callers return
/// early, which nextest reports as a pass — so a lane whose layout stopped
/// matching what the gates read goes green having run nothing (#741). The tier
/// makes that failure loud, and makes the *wrong* weights loud too: a lane on
/// stand-ins must not claim real coverage, and a lane that meant to use
/// stand-ins must not quietly start paying for real ones again.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum RequiredModels {
    Real,
    Mini,
}

/// `KESHA_REQUIRE_MODEL_TESTS`: unset/empty/`0` skips freely, `mini` demands the
/// stand-ins, anything else truthy demands real weights.
pub fn required_models(flag: Option<&str>) -> Option<RequiredModels> {
    match flag {
        None | Some("") | Some("0") => None,
        Some(v) if v.eq_ignore_ascii_case("mini") => Some(RequiredModels::Mini),
        Some(_) => Some(RequiredModels::Real),
    }
}

pub fn models_required() -> Option<RequiredModels> {
    required_models(std::env::var("KESHA_REQUIRE_MODEL_TESTS").ok().as_deref())
}

/// The mini stand-ins satisfy every structural gate by construction, so a lane
/// staged with them would pass `KESHA_REQUIRE_MODEL_TESTS` having proved nothing
/// about the real weights — the loud signal would go quiet exactly where it
/// matters. The marker beside the model is what tells the two apart (#741).
///
/// Checks the link's own directory *and* the resolved target's: staging shapes
/// differ, and say-e2e symlinks the model into a temp cache, which leaves the
/// marker behind at the target.
pub fn staged_with_mini_models(model: &Path) -> bool {
    let mut candidates = vec![model.to_path_buf()];
    if let Ok(resolved) = std::fs::canonicalize(model) {
        candidates.push(resolved);
    }
    candidates
        .iter()
        .filter_map(|p| p.parent())
        .any(|dir| dir.join("MINI-MODEL.json").exists())
}

/// Every gate below funnels through this, so a new gate that forgets it is the
/// only way back to a lane running against weights it did not promise.
fn assert_staged_tier_matches(model: &Path) {
    let Some(required) = models_required() else {
        return;
    };
    let staged = if staged_with_mini_models(model) {
        RequiredModels::Mini
    } else {
        RequiredModels::Real
    };
    assert_eq!(
        staged,
        required,
        "KESHA_REQUIRE_MODEL_TESTS asks for {required:?} weights but {} is {staged:?} — \
         a lane cannot claim real coverage off a stand-in, and a lane meant for stand-ins \
         should not be paying to download real ones (#741)",
        model.display()
    );
}

/// `KOKORO_MODEL` + `KOKORO_VOICE` env-var skip gate.
///
/// Returns `Some((model, voice))` when both vars are set, `None` otherwise.
/// The historical pattern: tests that need a real Kokoro model + voice file
/// skip silently on CI runs that don't stage them. Callers print the skip
/// reason themselves so each test owns its own message.
pub fn kokoro_paths_or_skip() -> Option<(String, String)> {
    if let (Ok(m), Ok(v)) = (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        assert_staged_tier_matches(Path::new(&m));
        return Some((m, v));
    }
    assert!(
        models_required().is_none(),
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
        assert_staged_tier_matches(&model);
        return Some(base);
    }
    assert!(
        models_required().is_none(),
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
        assert_staged_tier_matches(&model);
        return Some((model, voice));
    }
    assert!(
        models_required().is_none(),
        "Kokoro graph or voice {voice_name} missing under {} while \
         KESHA_REQUIRE_MODEL_TESTS is set — this lane stages the voice packs, so \
         skipping here would be a green run of nothing (#741)",
        cache.display()
    );
    None
}

/// `VAD_MODEL` env var, else the pinned Silero location under the cache base.
///
/// Deliberately not routed through [`assert_staged_tier_matches`]: Silero has no
/// mini stand-in, and the PR matrix promises `KESHA_REQUIRE_MODEL_TESTS: mini`,
/// so the tier check would fail the moment a lane actually staged the real 2.3 MB
/// file. `KESHA_REQUIRE_VAD_TESTS` is the separate promise, following the
/// `KESHA_REQUIRE_VOSK_TESTS` / `KESHA_REQUIRE_G2P_TESTS` precedent (#990).
pub fn vad_model_or_skip(test: &str) -> Option<PathBuf> {
    let path = std::env::var_os("VAD_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| cache_base().join("models/silero-vad/silero_vad.onnx"));
    if path.is_file() {
        return Some(path);
    }
    assert!(
        std::env::var_os("KESHA_REQUIRE_VAD_TESTS").is_none(),
        "Silero VAD not staged at {} while KESHA_REQUIRE_VAD_TESTS is set — \
         this lane downloads it, so a missing file is a broken layout, not a laptop",
        path.display()
    );
    eprintln!(
        "Silero VAD not staged at {} — skipping {test}",
        path.display()
    );
    None
}

/// An LFS pointer stub is still a valid audio-extension path, so a decoder fails deep inside its
/// probe with a message that never mentions LFS — panics with the actionable hint instead (#990).
pub fn assert_not_lfs_pointer(path: &Path) {
    if let Ok(bytes) = std::fs::read(path) {
        if bytes.starts_with(b"version https://git-lfs.github.com/spec") {
            panic!(
                "{} is an LFS pointer stub, not audio — run `git lfs pull`",
                path.display()
            );
        }
    }
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

/// Source text before the first `#[cfg(test)] mod` or `#[cfg(all(test, …))] mod`; an attribute on a single item would otherwise un-scan everything after it.
pub fn non_test_prefix(text: &str) -> &str {
    const MARKERS: [&str; 2] = ["#[cfg(test)]", "#[cfg(all(test,"];
    let mut from = 0;
    loop {
        let Some((at, marker)) = MARKERS
            .iter()
            .filter_map(|m| text[from..].find(m).map(|i| (from + i, *m)))
            .min_by_key(|(i, _)| *i)
        else {
            return text;
        };
        let Some(close) = text[at..].find(']') else {
            return text;
        };
        if text[at + close + 1..].trim_start().starts_with("mod ") {
            return &text[..at];
        }
        from = at + marker.len();
    }
}
