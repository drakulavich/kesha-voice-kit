//! Protocol v4 argument-parsing contract: clap failures join the event stream.
mod common;
use std::process::Command;

fn invalid_arg_event(stderr: &str) -> serde_json::Value {
    let v: serde_json::Value =
        serde_json::from_str(stderr.trim()).unwrap_or_else(|_| panic!("not an event: {stderr}"));
    assert_eq!(v["kind"], "error");
    assert_eq!(v["code"], "E_INVALID_ARG");
    v
}

#[test]
fn no_subcommand_is_an_invalid_arg_event_with_usage_and_exit_2() {
    let out = Command::new(common::engine_bin())
        .output()
        .expect("spawn engine");
    assert_eq!(out.status.code(), Some(2), "protocol-v4 D1: exit 2");
    let v = invalid_arg_event(&String::from_utf8_lossy(&out.stderr));
    assert!(v["message"]
        .as_str()
        .unwrap()
        .contains("Usage: kesha-engine"));
}

#[test]
fn clap_parse_error_is_an_invalid_arg_event_and_exit_2() {
    let out = Command::new(common::engine_bin())
        .args(["transcribe", "--no-such-flag", "x.wav"])
        .output()
        .expect("spawn engine");
    assert_eq!(out.status.code(), Some(2), "protocol-v4 D1: exit 2");
    invalid_arg_event(&String::from_utf8_lossy(&out.stderr));
}

#[test]
fn help_and_version_stay_on_stdout_with_exit_0() {
    for args in [
        ["--help"].as_slice(),
        ["--version"].as_slice(),
        ["transcribe", "--help"].as_slice(),
    ] {
        let out = Command::new(common::engine_bin())
            .args(args)
            .output()
            .expect("spawn engine");
        let what = args.join(" ");
        assert_eq!(out.status.code(), Some(0), "{what}");
        assert!(!out.stdout.is_empty(), "{what} prints to stdout");
        assert!(out.stderr.is_empty(), "{what} writes nothing to stderr");
    }
}
