mod common;
use std::process::Command;

#[test]
fn debug_events_ride_stderr_and_stdout_stays_payload() {
    let out = Command::new(common::engine_bin())
        .env("KESHA_DEBUG", "1")
        .arg("describe")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(stdout.lines().count(), 1, "payload is one line");
    serde_json::from_str::<serde_json::Value>(stdout.trim()).unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.trim().is_empty(),
        "KESHA_DEBUG=1 must emit at least the init trace"
    );
    for line in stderr.lines() {
        let v: serde_json::Value =
            serde_json::from_str(line).unwrap_or_else(|_| panic!("non-JSON stderr line: {line}"));
        assert_eq!(v["kind"], "debug");
        assert!(v["t_ms"].is_number());
    }
}
