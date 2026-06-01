//! Gated multilingual audio-regression test.
//!
//! Synthesizes each (lang, sentence) pair in `fixtures/tts/multilang_corpus.json`
//! via the real ONNX Kokoro path and asserts:
//! - non-empty WAV with correct 24000 Hz mono header,
//! - no clipping (locks Phase 3 `kokoro::clamp_audio`),
//! - non-silent RMS,
//! - plausible duration relative to grapheme count.
//!
//! Skip condition: `CHARSIU_ONNX` unset OR Kokoro model/voice absent from cache.
//! Run with:
//!   cd rust && CHARSIU_ONNX=~/.cache/kesha/models/g2p/byt5-tiny \
//!     cargo nextest run --features tts tts_multilang_audio

#![cfg(feature = "tts")]

mod common;

use std::collections::HashMap;
use std::path::PathBuf;

use hound::SampleFormat;
use kesha_engine::tts::{self, EngineChoice, OutputFormat, SayOptions};

/// Default ONNX voice for each language (mirrors `voices::default_voice_for_lang`).
fn default_voice(lang: &str) -> &'static str {
    match lang {
        "es" => "em_alex",
        "fr" => "ff_siwis",
        "it" => "im_nicola",
        "pt" => "pm_alex",
        _ => panic!("no default voice for lang {lang}"),
    }
}

/// Skip gate: both `CHARSIU_ONNX` must be set AND Kokoro model + the relevant
/// voice must be present. Returns `(model_path, voice_path)` or `None`.
fn multilang_paths_or_skip(lang: &str) -> Option<(PathBuf, PathBuf)> {
    // Gate 1: G2P model present.
    if std::env::var_os("CHARSIU_ONNX").is_none() {
        eprintln!("skipping tts_multilang_audio: CHARSIU_ONNX not set");
        return None;
    }
    // Gate 2: Kokoro model + voice from cache.
    let cache = common::kokoro_cache_dir_or_skip()?;
    let model = cache.join("models/kokoro-82m/model.onnx");
    let voice_name = default_voice(lang);
    let voice = cache
        .join("models/kokoro-82m/voices")
        .join(format!("{voice_name}.bin"));
    if !model.exists() || !voice.exists() {
        eprintln!("skipping tts_multilang_audio[{lang}]: model or voice {voice_name} not in cache");
        return None;
    }
    Some((model, voice))
}

/// Parse a WAV buffer with `hound` and return `(sample_rate, channel_count, f32_samples)`.
/// Panics on malformed input so failures surface as assertion errors.
fn parse_wav(wav: &[u8]) -> (u32, u16, Vec<f32>) {
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

/// RMS of a sample slice.
fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

fn run_corpus_for_lang(lang: &str, sentences: &[String]) {
    let Some((model_path, voice_path)) = multilang_paths_or_skip(lang) else {
        return;
    };

    for sentence in sentences {
        let grapheme_count = sentence.chars().count() as f32;

        let wav = tts::say(SayOptions {
            text: sentence,
            lang,
            engine: EngineChoice::Kokoro {
                model_path: &model_path,
                voice_path: &voice_path,
                speed: 1.0,
            },
            ssml: false,
            format: OutputFormat::Wav,
            expand_abbrev: true,
        })
        .unwrap_or_else(|e| panic!("[{lang}] synthesis failed for {:?}: {e}", sentence));

        // 1. Non-empty bytes.
        assert!(!wav.is_empty(), "[{lang}] WAV is empty for {:?}", sentence);

        // Parse WAV properly via hound (handles variable fmt chunk sizes).
        let (sample_rate, channels, samples) = parse_wav(&wav);

        // 2. 24000 Hz mono.
        assert_eq!(
            sample_rate, 24_000,
            "[{lang}] expected 24000 Hz, got {sample_rate}"
        );
        assert_eq!(
            channels, 1,
            "[{lang}] expected mono (1 channel), got {channels}"
        );

        assert!(
            !samples.is_empty(),
            "[{lang}] audio is empty for {:?}",
            sentence
        );

        // 3. No clipping — locks `kokoro::clamp_audio` (Phase 3).
        for (i, &s) in samples.iter().enumerate() {
            assert!(
                (-1.0..=1.0).contains(&s),
                "[{lang}] clipping at sample {i}: {s} (sentence: {:?})",
                sentence
            );
        }

        // 4. Non-silent: RMS > 0.01.
        let r = rms(&samples);
        assert!(
            r > 0.01,
            "[{lang}] audio is near-silent (RMS={r:.4}) for {:?}",
            sentence
        );

        // 5. Plausible length: duration in [0.3, 1.5] × (grapheme_count / 12).
        //    Loose band — catches near-zero or catastrophically long output only.
        let sample_count = samples.len();
        let duration_secs = sample_count as f32 / sample_rate as f32;
        let reference = grapheme_count / 12.0; // ~12 graphemes/sec as baseline
        let lo = reference * 0.3;
        let hi = reference * 1.5;
        assert!(
            duration_secs >= lo && duration_secs <= hi,
            "[{lang}] duration {duration_secs:.2}s outside [{lo:.2}, {hi:.2}]s \
             for {grapheme_count:.0}-grapheme sentence {:?}",
            sentence
        );
    }
}

#[test]
fn multilang_audio_regression_es() {
    let corpus = load_corpus();
    let sentences = corpus.get("es").map(Vec::as_slice).unwrap_or(&[]);
    run_corpus_for_lang("es", sentences);
}

#[test]
fn multilang_audio_regression_fr() {
    let corpus = load_corpus();
    let sentences = corpus.get("fr").map(Vec::as_slice).unwrap_or(&[]);
    run_corpus_for_lang("fr", sentences);
}

#[test]
fn multilang_audio_regression_it() {
    let corpus = load_corpus();
    let sentences = corpus.get("it").map(Vec::as_slice).unwrap_or(&[]);
    run_corpus_for_lang("it", sentences);
}

#[test]
fn multilang_audio_regression_pt() {
    let corpus = load_corpus();
    let sentences = corpus.get("pt").map(Vec::as_slice).unwrap_or(&[]);
    run_corpus_for_lang("pt", sentences);
}

fn load_corpus() -> HashMap<String, Vec<String>> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/tts/multilang_corpus.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read corpus fixture {path}: {e}"));
    serde_json::from_str(&raw).expect("corpus JSON must be a map of lang → [sentence]")
}
