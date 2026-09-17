//! Exploratory S8-8: a plain transcribe emits protocol-4 `progress` events, so a library caller
//! wiring `TranscribeOptions.onProgressLine` to a spinner sees it move instead of reading as hung.
//! Runs the freshly built engine against the cached ASR weights; skips when they are not installed.
mod common;
use std::path::PathBuf;
use std::process::Command;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust/ has a parent")
        .join("tests/fixtures/benchmark-en/01-check-email.ogg")
}

#[test]
fn a_plain_transcribe_narrates_its_progress_on_stderr() {
    if !common::asr_model_or_skip("a_plain_transcribe_narrates_its_progress_on_stderr") {
        return;
    }
    let path = fixture();
    common::assert_not_lfs_pointer(&path);

    let out = Command::new(common::engine_bin())
        .arg("transcribe")
        .arg(&path)
        .output()
        .expect("spawn engine");
    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let stderr = String::from_utf8_lossy(&out.stderr);
    let progressed = stderr.lines().any(|line| {
        serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .is_some_and(|v| v["kind"] == "progress")
    });
    assert!(
        progressed,
        "a plain transcribe emitted no progress event; stderr was:\n{stderr}"
    );
}
