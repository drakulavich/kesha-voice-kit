//! `trace_json` reaches the caller as a structured `debug` event on stderr, replacing the F19 `KESHA_DEBUG_FD` sink.
//!
//! Its own integration binary because `enabled()` caches `KESHA_DEBUG` process-wide, and this test needs it on.

use std::process::Command;

const RELAY: &str = "KESHA_TRACE_JSON_RELAY";
const TEST: &str = "structured_debug_events_carry_the_event_name_and_fields";

#[test]
fn structured_debug_events_carry_the_event_name_and_fields() {
    if std::env::var(RELAY).is_ok() {
        kesha_engine::debug::trace_json("test.first", serde_json::json!({"x": 1, "label": "ok"}));
        kesha_engine::debug::trace_json("test.second", serde_json::json!({"y": 2}));
        return;
    }

    let out = Command::new(std::env::current_exe().expect("test binary path"))
        .args(["--exact", TEST, "--nocapture"])
        .env(RELAY, "1")
        .env("KESHA_DEBUG", "1")
        // A stale export must not divert the events any more (protocol-v4: the descriptor is gone).
        .env("KESHA_DEBUG_FD", "3")
        .output()
        .expect("re-run this test in a child process");
    assert!(out.status.success(), "child failed: {out:?}");

    let stderr = String::from_utf8_lossy(&out.stderr);
    let events: Vec<serde_json::Value> = stderr
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|_| panic!("non-event stderr line: {l}")))
        .collect();
    assert_eq!(events.len(), 2, "expected 2 debug events, got: {stderr}");

    assert_eq!(events[0]["kind"], "debug");
    assert_eq!(events[0]["event"], "test.first");
    assert_eq!(events[0]["fields"]["x"], 1);
    assert_eq!(events[0]["fields"]["label"], "ok");
    assert!(events[0]["t_ms"].is_u64(), "t_ms missing: {}", events[0]);

    assert_eq!(events[1]["event"], "test.second");
    assert_eq!(events[1]["fields"]["y"], 2);
}
