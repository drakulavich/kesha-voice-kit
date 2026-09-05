//! Protocol v4 argument-parsing contract: clap failures join the event stream.
mod common;
use std::process::Command;

#[test]
fn no_subcommand_is_an_invalid_arg_event_with_usage_and_exit_2() {
    let out = Command::new(common::engine_bin())
        .env("KESHA_PROTOCOL", "4")
        .output()
        .expect("spawn engine");
    assert_eq!(out.status.code(), Some(2), "protocol-v4 D1: exit 2");
    let v: serde_json::Value =
        serde_json::from_str(String::from_utf8_lossy(&out.stderr).trim()).unwrap();
    assert_eq!(v["code"], "E_INVALID_ARG");
    assert!(v["message"]
        .as_str()
        .unwrap()
        .contains("Usage: kesha-engine"));
}

#[test]
fn clap_parse_error_is_an_invalid_arg_event_and_exit_2_in_both_modes() {
    for env in [None, Some("4")] {
        let mut cmd = Command::new(common::engine_bin());
        if let Some(v) = env {
            cmd.env("KESHA_PROTOCOL", v);
        }
        let out = cmd
            .args(["transcribe", "--no-such-flag", "x.wav"])
            .output()
            .expect("spawn engine");
        assert_eq!(out.status.code(), Some(2), "protocol-v4 D1: exit 2");
        let stderr = String::from_utf8_lossy(&out.stderr);
        match env {
            None => assert!(
                stderr.starts_with("error [E_INVALID_ARG]:"),
                "v3 line, got: {stderr}"
            ),
            Some(_) => assert!(
                stderr.trim_start().starts_with("{\"kind\":\"error\""),
                "v4 event, got: {stderr}"
            ),
        }
    }
}

#[test]
fn help_and_version_stay_on_stdout_with_exit_0() {
    for flag in ["--help", "--version"] {
        let out = Command::new(common::engine_bin())
            .env("KESHA_PROTOCOL", "4")
            .arg(flag)
            .output()
            .expect("spawn engine");
        assert_eq!(out.status.code(), Some(0), "{flag}");
        assert!(!out.stdout.is_empty(), "{flag} prints to stdout");
        assert!(out.stderr.is_empty(), "{flag} writes nothing to stderr");
    }
}
