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

#[test]
fn a_rate_outside_the_engine_safe_range_is_an_invalid_argument_before_any_engine() {
    let tmp = tempfile::tempdir().unwrap();
    for bad in ["0", "NaN", "inf", "0.4", "2.5"] {
        let out = say(&["Hello there", "--rate", bad], tmp.path());
        assert_eq!(out.status.code(), Some(2), "--rate {bad}: {:?}", out.status);
        assert!(
            out.stdout.is_empty(),
            "--rate {bad}: nothing may be synthesized"
        );
        let v = common::sole_error_event(&out);
        assert_eq!(v["code"], "E_INVALID_ARG", "--rate {bad}: {v}");
        assert!(
            v["message"].as_str().unwrap().contains("0.5"),
            "--rate {bad}: {v}"
        );
    }
}

#[test]
fn the_documented_rate_endpoints_pass_the_pre_flight() {
    let tmp = tempfile::tempdir().unwrap();
    for ok in ["0.5", "1", "2.0"] {
        let out = say(
            &["Hello there", "--voice", "xx-nope", "--rate", ok],
            tmp.path(),
        );
        assert_ne!(
            out.status.code(),
            Some(2),
            "--rate {ok} must not be refused"
        );
    }
}

#[test]
fn an_out_path_that_is_a_directory_is_an_invalid_argument_before_synthesis() {
    let tmp = tempfile::tempdir().unwrap();
    let out = say(
        &["Hello there", "--out", tmp.path().to_str().unwrap()],
        tmp.path(),
    );
    assert_eq!(out.status.code(), Some(2), "{:?}", out.status);
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    let msg = v["message"].as_str().unwrap();
    assert!(msg.contains(tmp.path().to_str().unwrap()), "{v}");
    assert!(msg.contains("os error"), "the OS reason is the value: {v}");
}

#[test]
fn an_out_path_under_a_missing_directory_is_an_invalid_argument() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("nope/speech.wav");
    let out = say(
        &["Hello there", "--out", target.to_str().unwrap()],
        tmp.path(),
    );
    assert_eq!(out.status.code(), Some(2), "{:?}", out.status);
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("os error"),
        "the OS reason is the value: {v}"
    );
}

#[cfg(unix)]
#[test]
fn an_unwritable_out_location_is_an_invalid_argument() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let locked = tmp.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    let target = locked.join("speech.wav");
    let out = say(
        &["Hello there", "--out", target.to_str().unwrap()],
        tmp.path(),
    );
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(out.status.code(), Some(2), "{:?}", out.status);
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("Permission denied"),
        "{v}"
    );
}

#[cfg(unix)]
#[test]
fn a_character_device_out_is_refused_naming_the_stdout_default() {
    let tmp = tempfile::tempdir().unwrap();
    for device in ["/dev/stdout", "/dev/null"] {
        let out = say(&["Hello there", "--out", device], tmp.path());
        assert_eq!(out.status.code(), Some(2), "{device}: {:?}", out.status);
        assert!(out.stdout.is_empty(), "{device}: nothing may be written");
        let v = common::sole_error_event(&out);
        assert_eq!(v["code"], "E_INVALID_ARG", "{device}: {v}");
        assert!(
            v["message"].as_str().unwrap().contains("omit --out"),
            "{device}: the message must name the plain-stdout default: {v}"
        );
        assert_eq!(
            v["message"],
            format!("--out {device} is a character device, where the audio would be discarded; omit --out to write it to stdout"),
            "{device}: both doors print one message (D4)"
        );
    }
}

/// A fifo `--out` streams today (175 KB verified in the T1-15 run) and the probe must not open it.
#[cfg(unix)]
#[test]
fn a_fifo_out_passes_the_pre_flight_without_blocking_on_a_reader() {
    let tmp = tempfile::tempdir().unwrap();
    let fifo = tmp.path().join("speech.fifo");
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo")
        .success());
    let mut child = Command::new(common::engine_bin())
        .args(["say", "Hello there", "--voice", "xx-nope", "--out"])
        .arg(&fifo)
        .env("KESHA_CACHE_DIR", tmp.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn engine");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let status = loop {
        match child.try_wait().expect("poll engine") {
            Some(status) => break status,
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                panic!("the --out pre-flight blocked on a fifo with no reader");
            }
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    };
    assert_ne!(status.code(), Some(2), "a fifo --out must not be refused");
}

/// The probe may remove only what it created itself: a path that already resolves to something (here a
/// symlink whose target is not there yet) is another party's, so `--out` through it must leave it alone.
#[cfg(unix)]
#[test]
fn the_out_probe_never_removes_a_path_it_did_not_create() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("target.wav");
    let link = tmp.path().join("speech.wav");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    let out = say(
        &[
            "Hello there",
            "--voice",
            "xx-nope",
            "--out",
            link.to_str().unwrap(),
        ],
        tmp.path(),
    );
    assert_ne!(
        out.status.code(),
        Some(2),
        "a writable path behind a symlink passes the probe: {:?}",
        out
    );
    assert!(
        std::fs::symlink_metadata(&link).is_ok(),
        "the probe deleted the caller's symlink"
    );
    assert!(
        !target.exists(),
        "the probe left an empty target behind the symlink of a request that failed"
    );
}

#[test]
fn a_refused_run_neither_truncates_nor_creates_the_out_file() {
    let tmp = tempfile::tempdir().unwrap();
    let existing = tmp.path().join("keep.wav");
    std::fs::write(&existing, b"previous audio").unwrap();
    let fresh = tmp.path().join("fresh.wav");

    let out = say(
        &[
            "Hello there",
            "--voice",
            "xx-nope",
            "--out",
            existing.to_str().unwrap(),
        ],
        tmp.path(),
    );
    assert_ne!(out.status.code(), Some(0));
    assert_eq!(std::fs::read(&existing).unwrap(), b"previous audio");

    let out = say(
        &[
            "Hello there",
            "--voice",
            "xx-nope",
            "--out",
            fresh.to_str().unwrap(),
        ],
        tmp.path(),
    );
    assert_ne!(out.status.code(), Some(0));
    assert!(
        !fresh.exists(),
        "a failed run must leave no empty --out file"
    );
}

#[cfg(all(feature = "system_tts", target_os = "macos"))]
#[test]
fn a_macos_voice_this_mac_has_not_downloaded_exits_1_as_voice_unknown() {
    let tmp = tempfile::tempdir().unwrap();
    let out = say(
        &[
            "Hello there",
            "--voice",
            "macos-com.apple.voice.premium.en-US.NoSuchVoice",
        ],
        tmp.path(),
    );
    assert_eq!(out.status.code(), Some(1), "{:?}", out.status);
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_VOICE_UNKNOWN", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("System Settings"),
        "{v}"
    );
}
