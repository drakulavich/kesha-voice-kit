//! End-to-end TTS: real model, real voice, ONNX G2P → produces real WAV bytes.
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
        ssml: false,
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
    let res = tts::say(SayOptions {
        text: "",
        lang: "en-us",
        engine: EngineChoice::Kokoro {
            model_path: Path::new("/nonexistent"),
            voice_path: Path::new("/nonexistent"),
            speed: 1.0,
        },
        ssml: false,
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
        ssml: false,
    });
    assert!(matches!(res, Err(TtsError::TextTooLong { .. })));
}

#[test]
fn kokoro_ssml_with_break_produces_wav() {
    let (model, voice) = match (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        (Ok(m), Ok(v)) => (m, v),
        _ => {
            eprintln!("skipping: set KOKORO_MODEL + KOKORO_VOICE");
            return;
        }
    };
    let wav = tts::say(SayOptions {
        text: r#"<speak>Hello <break time="300ms"/> world</speak>"#,
        lang: "en-us",
        engine: EngineChoice::Kokoro {
            model_path: Path::new(&model),
            voice_path: Path::new(&voice),
            speed: 1.0,
        },
        ssml: true,
    })
    .unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    // Must be at least the audio for "Hello" + 300ms of silence + "world".
    // ~300ms @ 24kHz mono f32 = 28.8 KB just in silence.
    assert!(
        wav.len() > 44 + 24_000,
        "audio too short: {} bytes",
        wav.len()
    );
}

#[test]
fn ssml_input_without_speak_root_errors() {
    let res = tts::say(SayOptions {
        text: "plain text, not SSML",
        lang: "en-us",
        engine: EngineChoice::Kokoro {
            model_path: Path::new("/nonexistent"),
            voice_path: Path::new("/nonexistent"),
            speed: 1.0,
        },
        ssml: true,
    });
    assert!(matches!(res, Err(TtsError::SynthesisFailed(_))));
}
