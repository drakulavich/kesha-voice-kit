//! Issue #232 — Russian acronym auto-expansion + <say-as> integration.
//!
//! Asserts byte-length deltas through the full Vosk synth pipeline so a
//! regression in the new tts::ru layer (or in how SayOptions threads
//! `expand_abbrev`) shows up as a hard test failure rather than a
//! subjective audio change.

#![cfg(feature = "tts")]

use std::path::PathBuf;

use kesha_engine::tts::{self, EngineChoice, OutputFormat, SayOptions};

/// Return the vosk-ru model dir if the required runtime files are present;
/// otherwise return None so callers can skip gracefully.
///
/// Strategy: use KESHA_CACHE_DIR when set (matches CI / local dev fixture
/// layout), otherwise fall back to the default `~/.cache/kesha`. This mirrors
/// what `models::vosk_ru_model_dir()` does in production — no staging copy
/// needed because these tests are read-only.
fn vosk_model_dir_or_skip() -> Option<PathBuf> {
    let base = if let Ok(dir) = std::env::var("KESHA_CACHE_DIR") {
        PathBuf::from(dir)
    } else {
        // Same logic as models::cache_dir() for the default path.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join(".cache/kesha")
    };

    let model_dir = base.join("models/vosk-ru");

    // Mirror models::is_vosk_ru_cached() — keep gates aligned.
    if model_dir.join("model.onnx").exists()
        && model_dir.join("dictionary").exists()
        && model_dir.join("bert/model.onnx").exists()
    {
        Some(model_dir)
    } else {
        None
    }
}

fn synth(text: &str, ssml: bool, expand_abbrev: bool, model_dir: &PathBuf) -> Vec<u8> {
    tts::say(SayOptions {
        text,
        lang: "ru",
        engine: EngineChoice::Vosk {
            model_dir,
            // speaker_id 4 = ru-vosk-m02 (male), per voices.rs ru-vosk-* mapping
            speaker_id: 4,
            speed: 1.0,
        },
        ssml,
        format: OutputFormat::Wav,
        expand_abbrev,
    })
    .expect("synth ok")
}

// =============================================================================
// Tests
// =============================================================================

/// Auto-expanding "ФСБ" (3 all-consonant letters → "фэ эс бэ", 6 syllables)
/// must produce noticeably more audio than passing "ФСБ" straight to Vosk
/// without expansion. Threshold: ≥1.7× by byte count.
///
/// Note: ВОЗ is no longer used here because the vowel-cluster rule (#232)
/// passes it through as a word (alternating C-V-C reads fine as "воз").
/// ФСБ has no vowels → always spells.
#[test]
fn auto_expand_plain_fsb_is_longer_than_noexpand() {
    let model_dir = match vosk_model_dir_or_skip() {
        Some(d) => d,
        None => {
            eprintln!(
                "skipping auto_expand_plain_fsb_is_longer_than_noexpand: vosk-ru models not found"
            );
            return;
        }
    };

    let expanded = synth(
        "ФСБ", /*ssml=*/ false, /*expand_abbrev=*/ true, &model_dir,
    );
    let plain = synth(
        "ФСБ", /*ssml=*/ false, /*expand_abbrev=*/ false, &model_dir,
    );

    let ratio = expanded.len() as f64 / plain.len() as f64;
    assert!(
        ratio > 1.7,
        "expanded={} plain={} ratio={:.2} (expected >1.7×)",
        expanded.len(),
        plain.len(),
        ratio,
    );
}

/// `<say-as interpret-as="characters">ФСБ</say-as>` must spell out the letters
/// just like auto-expand does, so the audio length should be within ±10% of
/// the auto-expanded form.
#[test]
fn say_as_characters_matches_auto_expand_within_tolerance() {
    let model_dir = match vosk_model_dir_or_skip() {
        Some(d) => d,
        None => {
            eprintln!("skipping say_as_characters_matches_auto_expand_within_tolerance: vosk-ru models not found");
            return;
        }
    };

    let auto = synth("ФСБ", false, true, &model_dir);
    let ssml = synth(
        r#"<speak><say-as interpret-as="characters">ФСБ</say-as></speak>"#,
        true,
        false, // <say-as> wins regardless of expand_abbrev flag
        &model_dir,
    );

    let ratio = ssml.len() as f64 / auto.len() as f64;
    assert!(
        (0.9..=1.1).contains(&ratio),
        "auto={} ssml={} ratio={:.2} (expected 0.9..=1.1)",
        auto.len(),
        ssml.len(),
        ratio,
    );
}

/// Sanity check: with `expand_abbrev=false`, uppercase "ВОЗ" is passed
/// verbatim to Vosk (same as the lowercase word "воз"). The two audio clips
/// must be within ±30% of each other in byte length.
#[test]
fn no_expand_baseline_matches_lowercase_form() {
    let model_dir = match vosk_model_dir_or_skip() {
        Some(d) => d,
        None => {
            eprintln!(
                "skipping no_expand_baseline_matches_lowercase_form: vosk-ru models not found"
            );
            return;
        }
    };

    let upper = synth("ВОЗ", false, false, &model_dir);
    let lower = synth("воз", false, false, &model_dir);

    let ratio = upper.len() as f64 / lower.len() as f64;
    assert!(
        (0.7..=1.3).contains(&ratio),
        "upper={} lower={} ratio={:.2} (expected 0.7..=1.3)",
        upper.len(),
        lower.len(),
        ratio,
    );
}
