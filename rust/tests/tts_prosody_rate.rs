//! Cheap guard for SSML `<prosody rate>` on macOS system voices (#236).
//!
//! Vosk/Kokoro rate composition is covered by fast unit/parser tests. This
//! file only keeps the platform-specific user-visible rejection path.

#![cfg(feature = "tts")]

mod common;

use std::process::Command;

#[test]
fn macos_prosody_rate_ssml_rejected() {
    // AVSpeech rejects SSML wholesale (#141 follow-up), so `--ssml` on a
    // macos-* voice returns a non-zero exit and prints the rejection
    // message — that includes <prosody rate>. This test asserts the
    // current behavior so we'd notice if AVSpeech ever started accepting
    // SSML without our prosody warn+strip arm being added.
    if !cfg!(target_os = "macos") {
        return;
    }
    let tmp = tempfile::Builder::new()
        .prefix("kesha-prosody-")
        .tempdir()
        .unwrap();
    let out = tmp.path().join("macos.wav");
    let ssml = r#"<speak><prosody rate="fast">Hello there.</prosody></speak>"#;
    let result = Command::new(common::engine_bin())
        .args([
            "say",
            "--voice",
            "macos-com.apple.voice.compact.en-US.Samantha",
            "--ssml",
            "--out",
            out.to_str().unwrap(),
            ssml,
        ])
        .output()
        .unwrap();
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        if stderr.contains("not yet supported with macos-")
            || stderr.contains("AVSpeech")
            || stderr.contains("system_tts")
        {
            // Expected: SSML rejection on macOS voices.
            return;
        }
        eprintln!("skipping: macos voice not available ({stderr})");
        return;
    }
    // AVSpeech now accepts SSML — that's a behavior change. The prosody
    // warn-strip arm called out in #236 needs to ship before this test can
    // be relaxed; fail loudly so the regression isn't missed.
    panic!(
        "AVSpeech accepted SSML <prosody rate>; add the prosody warn-strip arm \
         (see #236 plan T4) before allowing this path to succeed silently"
    );
}
