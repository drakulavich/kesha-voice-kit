mod common;
use std::process::Command;

#[test]
fn describe_prints_one_json_object_and_nothing_on_stderr() {
    let out = Command::new(common::engine_bin())
        .arg("describe")
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(0));
    assert!(
        out.stderr.is_empty(),
        "stderr must be empty: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1);
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(v["protocolVersion"], 4);
    assert_eq!(
        v["commands"]["transcribe"]["flags"]["speakers"]["gate"],
        "transcribe.diarize"
    );
    assert_eq!(
        v["commands"]["transcribe"]["flags"]["speakers"]["requires"][0],
        "json"
    );
    assert!(v["errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["code"] == "E_ENGINE_PROTOCOL" && e["origin"] == "cli"));
    assert!(v["features"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "transcribe"));
}

#[test]
fn legacy_error_codes_flag_still_answers_during_the_window() {
    let out = Command::new(common::engine_bin())
        .arg("--error-codes-json")
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(0));
    assert!(
        out.stderr.is_empty(),
        "stderr must be empty: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let codes: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert!(!codes.is_empty(), "the code registry must not be empty");
    assert!(codes.iter().any(|e| e["code"] == "E_INVALID_ARG"));
}

#[test]
fn legacy_capabilities_flag_still_answers_during_the_window() {
    let out = Command::new(common::engine_bin())
        .arg("--capabilities-json")
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(0));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["protocolVersion"], 3);
}
