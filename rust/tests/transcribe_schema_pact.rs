//! Extractor side of the transcribe schema pact (#917).
//!
//! #905 added `words` to `TranscriptionSegment` and the TS parser kept copying
//! only `start`/`end`/`text`/`speaker`, so the feature was invisible on every
//! user path while the engine-direct e2e stayed green; `speaker` needed the same
//! rescue in #199. Serde is the source of truth for what the engine puts on the
//! wire, so this serializes a fully-populated output — every `Option` `Some` —
//! and holds it against a committed recording.
//!
//! One extractor, two verifiers: `tests/unit/transcribe-schema-pact.test.ts`
//! drives the same recording through `parseTranscriptionOutput` and the TOON
//! encoder, so a field added here without a parser change turns that side red.

use std::path::PathBuf;

use kesha_engine::transcribe::{TranscriptionOutput, TranscriptionSegment, WordTiming};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust/ has a parent")
        .join("tests/fixtures/transcribe-schema.json")
}

/// Times are binary fractions so the `f32` → JSON → `f64` trip is exact.
fn fully_populated() -> TranscriptionOutput {
    TranscriptionOutput {
        text: "hello world goodbye now".to_string(),
        segments: vec![
            TranscriptionSegment {
                start: 0.0,
                end: 1.5,
                text: "hello world".to_string(),
                speaker: Some(0),
                words: Some(vec![
                    WordTiming {
                        word: "hello".to_string(),
                        start: 0.0,
                        end: 0.75,
                    },
                    WordTiming {
                        word: "world".to_string(),
                        start: 0.75,
                        end: 1.5,
                    },
                ]),
            },
            TranscriptionSegment {
                start: 1.5,
                end: 3.0,
                text: "goodbye now".to_string(),
                speaker: Some(1),
                words: Some(vec![
                    WordTiming {
                        word: "goodbye".to_string(),
                        start: 1.5,
                        end: 2.25,
                    },
                    WordTiming {
                        word: "now".to_string(),
                        start: 2.25,
                        end: 3.0,
                    },
                ]),
            },
        ],
    }
}

#[test]
fn the_serialized_output_matches_the_recorded_schema() {
    let emitted = serde_json::to_value(fully_populated()).expect("serialise");
    let path = fixture_path();

    if std::env::var_os("KESHA_UPDATE_TRANSCRIBE_PACT").is_some() {
        let pretty = serde_json::to_string_pretty(&emitted).expect("render");
        std::fs::write(&path, format!("{pretty}\n")).expect("write the recording");
    }

    let raw = std::fs::read_to_string(&path).expect("read the recording");
    let recorded: serde_json::Value = serde_json::from_str(&raw).expect("parse the recording");

    assert_eq!(
        emitted,
        recorded,
        "the transcribe wire format drifted from {}.\n\
         Re-record with `KESHA_UPDATE_TRANSCRIBE_PACT=1 cargo test --test transcribe_schema_pact`, \
         then teach `parseTranscriptionOutput` in src/engine.ts to forward the new field — \
         or name it in EXCLUDED_FIELDS in tests/unit/transcribe-schema-pact.test.ts with a reason.",
        path.display()
    );
}
