//! CLI-level assertions that a failure reaches the caller as one coded error event.
mod common;
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

// Exploratory S2-4: the ceiling is a documented product limit, not an engine fault, so its
// refusal must read as the caller's argument. Checked before any model is required, so the
// empty cache below cannot turn it into E_MODEL_MISSING.
#[test]
fn no_vad_over_the_single_pass_ceiling_is_an_invalid_argument_before_any_model_is_needed() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("marathon.wav");
    common::write_pcm16_wav(&wav, 16_000, 25 * 60 * 16_000, 250_000);
    let out = Command::new(engine_bin())
        .args(["transcribe", "--no-vad"])
        .arg(&wav)
        .env("KESHA_CACHE_DIR", dir.path().join("cache"))
        .output()
        .expect("spawn engine");
    assert_eq!(out.status.code(), Some(1));
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("single-pass limit"),
        "{v}"
    );
}
