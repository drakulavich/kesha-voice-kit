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
    if !kesha_engine::models::is_cached(kesha_engine::models::ModelKind::Asr) {
        // The mini stand-ins cannot transcribe, so only a lane promising real weights may not skip (#741).
        assert!(
            common::models_required() != Some(common::RequiredModels::Real),
            "ASR weights not installed while KESHA_REQUIRE_MODEL_TESTS demands real ones — a lane that stages them cannot skip this silently"
        );
        eprintln!("SKIP a_plain_transcribe_narrates_its_progress_on_stderr: ASR weights not installed (`kesha install`)");
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
