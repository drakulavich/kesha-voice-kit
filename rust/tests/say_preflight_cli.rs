//! `kesha-engine say` argument failures: the code, the exit status, and that no model is needed.

#![cfg(feature = "tts")]

mod common;

use std::process::Command;

/// The empty cache is the oracle: a probe that refuses late would answer `E_MODEL_MISSING`.
fn say(args: &[&str], cache: &std::path::Path) -> std::process::Output {
    Command::new(common::engine_bin())
        .arg("say")
        .args(args)
        .env("KESHA_CACHE_DIR", cache)
        .output()
        .expect("spawn engine")
}

#[test]
fn an_out_of_range_bitrate_is_an_invalid_argument_before_synthesis() {
    let tmp = tempfile::tempdir().unwrap();
    let out = say(
        &["Hello there", "--format", "ogg-opus", "--bitrate", "1"],
        tmp.path(),
    );
    assert_eq!(out.status.code(), Some(2), "{:?}", out.status);
    assert!(out.stdout.is_empty(), "nothing may be synthesized");
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains("--bitrate must be 6000..=510000 bps"),
        "{v}"
    );
}
