//! CLI-level assertions that a failure reaches the caller as one coded error event.
use std::process::Command;

fn engine_bin() -> String {
    std::env::var("CARGO_BIN_EXE_kesha-engine")
        .unwrap_or_else(|_| "target/release/kesha-engine".to_string())
}

#[test]
fn a_missing_input_is_reported_as_one_error_event() {
    let out = Command::new(engine_bin())
        .args(["transcribe", "/nonexistent/audio.wav"])
        .output()
        .expect("spawn engine");
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stdout.is_empty(),
        "protocol-v4 D1: stdout carries only the payload"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    let lines: Vec<&str> = stderr.lines().collect();
    assert_eq!(lines.len(), 1, "exactly one event, got: {stderr}");
    let v: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(v["kind"], "error");
    assert_eq!(v["code"], "E_INPUT_NOT_FOUND");
}
