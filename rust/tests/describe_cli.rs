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
fn the_legacy_flags_are_gone() {
    for flag in ["--capabilities-json", "--error-codes-json"] {
        let out = Command::new(common::engine_bin())
            .arg(flag)
            .output()
            .expect("spawn");
        assert_eq!(out.status.code(), Some(2), "{flag} must not parse");
        assert!(out.stdout.is_empty(), "{flag} must print no payload");
        let stderr = String::from_utf8_lossy(&out.stderr);
        let v: serde_json::Value =
            serde_json::from_str(stderr.trim()).unwrap_or_else(|_| panic!("{flag}: {stderr}"));
        assert_eq!(v["kind"], "error");
        assert_eq!(v["code"], "E_INVALID_ARG");
    }
}
