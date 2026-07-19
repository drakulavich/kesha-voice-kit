//! End-to-end TTS: real model, real voice, ONNX G2P → produces real WAV bytes.
//! Gated on engine-specific env vars so default CI without models stays fast.

#![cfg(feature = "tts")]

mod common;

use std::path::Path;

use kesha_engine::errors::ErrorCode;
use kesha_engine::tts::{self, EngineChoice, OutputFormat, SayOptions, TtsError};

#[test]
fn kokoro_hello_world_produces_wav() {
    let Some((model, voice)) = common::kokoro_paths_or_skip() else {
        eprintln!("skipping: set KOKORO_MODEL + KOKORO_VOICE");
        return;
    };
    let text = "Hello, world";
    let wav = tts::say(SayOptions {
        text,
        lang: "en-us",
        engine: EngineChoice::Kokoro {
            model_path: Path::new(&model),
            voice_path: Path::new(&voice),
            speed: 1.0,
        },
        ssml: false,
        format: OutputFormat::Wav,
        expand_abbrev: true,
    })
    .unwrap();
    let samples = common::assert_kokoro_speech(&wav, "hello_world");

    // Plausible duration: [0.3, 1.5] × (graphemes / 12), a loose band that only
    // catches near-zero or catastrophically long output (mirrors tts_multilang_audio).
    let duration = samples.len() as f32 / 24_000.0;
    let reference = text.chars().count() as f32 / 12.0;
    assert!(
        duration >= reference * 0.3 && duration <= reference * 1.5,
        "duration {duration:.2}s outside [{:.2}, {:.2}]s for {:?}",
        reference * 0.3,
        reference * 1.5,
        text
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
        format: OutputFormat::Wav,
        expand_abbrev: true,
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
        format: OutputFormat::Wav,
        expand_abbrev: true,
    });
    assert!(matches!(res, Err(TtsError::TextTooLong { .. })));
}

#[test]
fn kokoro_ssml_with_break_produces_wav() {
    let Some((model, voice)) = common::kokoro_paths_or_skip() else {
        eprintln!("skipping: set KOKORO_MODEL + KOKORO_VOICE");
        return;
    };
    let synth = |text: &str, ssml: bool| {
        tts::say(SayOptions {
            text,
            lang: "en-us",
            engine: EngineChoice::Kokoro {
                model_path: Path::new(&model),
                voice_path: Path::new(&voice),
                speed: 1.0,
            },
            ssml,
            format: OutputFormat::Wav,
            expand_abbrev: true,
        })
        .unwrap()
    };

    // Compare the same words with and without the break: the 300ms pause must
    // add a real span of silence. Byte-length alone (the old oracle) passes even
    // if the break is silently dropped and the words just run long.
    let with_break = synth(r#"<speak>Hello <break time="300ms"/> world</speak>"#, true);
    let no_break = synth(r#"<speak>Hello world</speak>"#, true);

    let with_break_samples = common::assert_kokoro_speech(&with_break, "ssml_break");
    let no_break_samples = common::assert_kokoro_speech(&no_break, "ssml_no_break");

    // 300ms @ 24kHz = 7200 samples; require ≥150ms extra to allow for prosody
    // variance between the two syntheses while still proving the break inserted silence.
    let extra = with_break_samples.len() as i64 - no_break_samples.len() as i64;
    assert!(
        extra >= 3_600,
        "300ms break added only {extra} samples (~{}ms); expected ≥150ms of silence",
        extra * 1000 / 24_000
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
        format: OutputFormat::Wav,
        expand_abbrev: true,
    });
    // A malformed SSML body now preserves the engine's SsmlInvalid code via
    // TtsError::Coded instead of collapsing into the generic SynthesisFailed.
    assert!(matches!(
        res,
        Err(TtsError::Coded {
            code: ErrorCode::SsmlInvalid,
            ..
        })
    ));
}
