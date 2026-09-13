//! `kesha-engine record --out` contracts a caller can observe without a microphone answering:
//! the output path is judged before the device opens, and the process does not outlive its parent.
#![cfg(target_os = "macos")]
mod common;
use std::process::Command;

fn record_to(out: &std::path::Path) -> std::process::Output {
    Command::new(common::engine_bin())
        .arg("record")
        .arg("--out")
        .arg(out)
        .args(["--max-seconds", "1"])
        .output()
        .expect("spawn engine")
}

// Exploratory S3-F4: a directory, a symlink to one, or an unwritable location as --out is the
// caller's argument. Each was E_INTERNAL, reported only after the recording had run its course.
#[test]
fn an_out_path_that_is_a_directory_is_an_invalid_argument_naming_the_os_reason() {
    let dir = tempfile::tempdir().unwrap();
    let out = record_to(dir.path());
    assert_eq!(out.status.code(), Some(1));
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    let message = v["message"].as_str().unwrap();
    assert!(message.contains("--out"), "{message}");
    assert!(
        message.contains(&dir.path().display().to_string()),
        "{message}"
    );
    assert!(message.contains("Is a directory"), "{message}");
}

#[test]
fn an_out_path_that_is_a_symlink_to_a_directory_is_an_invalid_argument() {
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join("recordings");
    std::os::unix::fs::symlink(dir.path(), &link).unwrap();
    let out = record_to(&link);
    assert_eq!(out.status.code(), Some(1));
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("Is a directory"),
        "{v}"
    );
}

#[test]
fn an_out_path_under_an_unwritable_directory_is_an_invalid_argument_naming_the_os_reason() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let locked = dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    let out = record_to(&locked.join("note.wav"));
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(out.status.code(), Some(1));
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("Permission denied"),
        "{v}"
    );
}
