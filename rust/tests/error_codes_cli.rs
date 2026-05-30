//! CLI-level assertions that failures print `error [CODE]:` on stderr.
use std::process::Command;

fn engine_bin() -> String {
    std::env::var("CARGO_BIN_EXE_kesha-engine")
        .unwrap_or_else(|_| "target/release/kesha-engine".to_string())
}

#[test]
fn transcribe_missing_file_prints_coded_error() {
    let out = Command::new(engine_bin())
        .args(["transcribe", "/nonexistent/path/audio.wav"])
        .output()
        .expect("spawn engine");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "should exit nonzero");
    assert!(
        stderr.contains("error [E_"),
        "stderr should carry a coded line, got: {stderr}"
    );
}
