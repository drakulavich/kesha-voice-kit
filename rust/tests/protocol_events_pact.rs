//! Emitter side of the protocol-events pact (#1478); `tests/unit/protocol-events-pact.test.ts` is the consumer side.

use std::path::PathBuf;

use kesha_engine::errors::ErrorCode;
use kesha_engine::protocol::events::{Event, W_VAD_NO_SPEECH};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust/ has a parent")
        .join("tests/fixtures/protocol-events.ndjson")
}

fn one_of_each_kind() -> Vec<Event<'static>> {
    vec![
        Event::progress_pct(Some("download"), "GET model.onnx", 12),
        Event::warn(W_VAD_NO_SPEECH, "no speech found"),
        Event::error(
            ErrorCode::ModelMissing,
            "the ASR model is missing",
            Some("kesha install"),
        ),
        Event::Debug {
            t_ms: 7,
            event: Some("asr.backend_loaded"),
            message: "asr::backend_loaded dt=12ms".to_string(),
            fields: serde_json::json!({ "dt_ms": 12 }),
        },
    ]
}

#[test]
fn the_rendered_events_match_the_recording() {
    let rendered: Vec<String> = one_of_each_kind().iter().map(Event::render).collect();
    let path = fixture_path();

    if std::env::var_os("KESHA_UPDATE_PROTOCOL_EVENTS_PACT").is_some() {
        let body: String = rendered.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(&path, body).expect("write the recording");
    }

    let raw = std::fs::read_to_string(&path).expect("read the recording");
    let parse = |line: &str| -> serde_json::Value { serde_json::from_str(line).expect("parse") };
    let recorded: Vec<serde_json::Value> = raw.lines().map(parse).collect();
    let emitted: Vec<serde_json::Value> = rendered.iter().map(|l| parse(l.as_str())).collect();

    assert_eq!(
        emitted,
        recorded,
        "the protocol event wire format drifted from {}.\n\
         Re-record with `KESHA_UPDATE_PROTOCOL_EVENTS_PACT=1 cargo test --test protocol_events_pact`, \
         then teach `parseEventLine` in src/engine/events.ts and the fakes in tests/ the new shape.",
        path.display()
    );
}
