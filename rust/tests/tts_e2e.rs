//! End-to-end TTS: real model, real voice, real espeak-ng → produces real WAV bytes.
//! Gated on KOKORO_MODEL + KOKORO_VOICE env vars so default CI without models stays fast.

#![cfg(feature = "tts")]

use std::path::Path;

#[test]
fn hello_world_produces_wav() {
    let (model, voice) = match (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        (Ok(m), Ok(v)) => (m, v),
        _ => {
            eprintln!("skipping: set KOKORO_MODEL + KOKORO_VOICE");
            return;
        }
    };
    let wav = kesha_engine::tts::say(kesha_engine::tts::SayOptions {
        text: "Hello, world",
        lang: "en-us",
        speed: 1.0,
        model_path: Path::new(&model),
        voice_path: Path::new(&voice),
    })
    .unwrap();
    assert_eq!(&wav[..4], b"RIFF", "not a WAV");
    assert!(
        wav.len() > 44 + 1000 * 4,
        "audio too short: {} bytes",
        wav.len()
    );
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

#[test]
fn too_long_errors() {
    let huge = "a".repeat(10_000);
    let res = kesha_engine::tts::say(kesha_engine::tts::SayOptions {
        text: &huge,
        lang: "en-us",
        speed: 1.0,
        model_path: Path::new("/nonexistent"),
        voice_path: Path::new("/nonexistent"),
    });
    assert!(matches!(
        res,
        Err(kesha_engine::tts::TtsError::TextTooLong { .. })
    ));
}
