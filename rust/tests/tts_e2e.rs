//! End-to-end TTS: real model, real voice, real espeak-ng → produces real WAV bytes.
//! Gated on engine-specific env vars so default CI without models stays fast.

#![cfg(feature = "tts")]

use std::path::Path;

use kesha_engine::tts::{self, EngineChoice, SayOptions, TtsError};

#[test]
fn kokoro_hello_world_produces_wav() {
    let (model, voice) = match (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        (Ok(m), Ok(v)) => (m, v),
        _ => {
            eprintln!("skipping: set KOKORO_MODEL + KOKORO_VOICE");
            return;
        }
    };
    let wav = tts::say(SayOptions {
        text: "Hello, world",
        lang: "en-us",
        engine: EngineChoice::Kokoro {
            model_path: Path::new(&model),
            voice_path: Path::new(&voice),
            speed: 1.0,
        },
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
fn piper_russian_produces_wav() {
    let (model, config) = match (std::env::var("PIPER_MODEL"), std::env::var("PIPER_CONFIG")) {
        (Ok(m), Ok(c)) => (m, c),
        _ => {
            eprintln!("skipping: set PIPER_MODEL + PIPER_CONFIG");
            return;
        }
    };
    let wav = tts::say(SayOptions {
        text: "Привет, мир",
        lang: "ru",
        engine: EngineChoice::Piper {
            model_path: Path::new(&model),
            config_path: Path::new(&config),
        },
    })
    .unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    assert!(
        wav.len() > 44 + 1000 * 4,
        "audio too short: {} bytes",
        wav.len()
    );
}

#[test]
fn empty_text_errors() {
    let res = tts::say(SayOptions {
        text: "",
        lang: "en-us",
        engine: EngineChoice::Kokoro {
            model_path: Path::new("/nonexistent"),
            voice_path: Path::new("/nonexistent"),
            speed: 1.0,
        },
    });
    assert!(matches!(res, Err(TtsError::EmptyText)));
}

#[test]
fn too_long_errors() {
    let huge = "a".repeat(10_000);
    let res = tts::say(SayOptions {
        text: &huge,
        lang: "en-us",
        engine: EngineChoice::Kokoro {
            model_path: Path::new("/nonexistent"),
            voice_path: Path::new("/nonexistent"),
            speed: 1.0,
        },
    });
    assert!(matches!(res, Err(TtsError::TextTooLong { .. })));
}
