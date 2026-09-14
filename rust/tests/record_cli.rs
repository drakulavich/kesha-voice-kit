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
    assert_eq!(
        out.status.code(),
        Some(2),
        "an --out the caller mistyped is exit 2, as docs/errors.md says"
    );
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
    assert_eq!(
        out.status.code(),
        Some(2),
        "an --out the caller mistyped is exit 2, as docs/errors.md says"
    );
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
    assert_eq!(
        out.status.code(),
        Some(2),
        "an --out the caller mistyped is exit 2, as docs/errors.md says"
    );
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("Permission denied"),
        "{v}"
    );
}

/// docs/errors.md gives one status per class, so the two commands that take `--out` cannot differ on it.
#[cfg(feature = "tts")]
#[test]
fn record_and_say_answer_a_directory_out_with_the_same_code_and_status() {
    let dir = tempfile::tempdir().unwrap();
    let recorded = record_to(dir.path());
    let said = Command::new(common::engine_bin())
        .args(["say", "Hello there", "--out"])
        .arg(dir.path())
        .env("KESHA_CACHE_DIR", dir.path().join("cache"))
        .output()
        .expect("spawn engine");
    assert_eq!(recorded.status.code(), said.status.code());
    assert_eq!(
        common::sole_error_event(&recorded)["code"],
        common::sole_error_event(&said)["code"]
    );
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 delivers nothing; it only asks whether the pid exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

// Exploratory S3-F1: a shell stands in for a SIGKILLed CLI (kill -9 $$) whose stdin a sibling holds open, so only noticing the vanished parent can stop the engine; it once recorded to --max-seconds.
#[test]
fn a_recording_whose_parent_dies_stops_within_a_second_and_writes_no_wav() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("stdin.fifo");
    let wav = dir.path().join("orphan.wav");
    let pid_file = dir.path().join("engine.pid");
    let err_file = dir.path().join("engine.stderr");
    let writer_pid_file = dir.path().join("writer.pid");
    let script = dir.path().join("run.sh");
    std::fs::write(
        &script,
        format!(
            "mkfifo '{fifo}'\n\
             sleep 30 > '{fifo}' &\n\
             echo $! > '{writer}'\n\
             sh -c 'exec 3<&0; \"{engine}\" record --out \"{wav}\" --max-seconds 20 <&3 2>\"{err}\" & \
             echo $! > \"{pid}\"; sleep 1; kill -0 $(cat \"{pid}\") 2>/dev/null && kill -9 $$ || exit 3' < '{fifo}'\n",
            fifo = fifo.display(),
            writer = writer_pid_file.display(),
            engine = common::engine_bin(),
            wav = wav.display(),
            err = err_file.display(),
            pid = pid_file.display(),
        ),
    )
    .unwrap();

    let status = Command::new("sh")
        .arg(&script)
        .status()
        .expect("run orchestrator");
    let engine_stderr = std::fs::read_to_string(&err_file).unwrap_or_default();
    if status.code() == Some(3) || engine_stderr.contains("\"kind\":\"error\"") {
        eprintln!(
            "engine never reached recording (no microphone?); skipping: {}",
            engine_stderr.trim()
        );
        return;
    }
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .expect("the shell recorded the engine pid")
        .trim()
        .parse()
        .expect("pid");

    let mut stopped = false;
    for _ in 0..20 {
        if !alive(pid) {
            stopped = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // Reaped only now: killing it sooner closes the engine's stdin and stops it the clean way (#1187), masking the parent-death path under test.
    if let Ok(w) = std::fs::read_to_string(&writer_pid_file) {
        if let Ok(w) = w.trim().parse::<i32>() {
            // SAFETY: the pid was written by this test's own shell; nothing else is signalled.
            unsafe { libc::kill(w, libc::SIGKILL) };
        }
    }
    if !stopped {
        // SAFETY: the pid was spawned by this test's shell; nothing else is reaped here.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    assert!(stopped, "the engine kept recording after its parent died");
    assert!(
        !wav.exists(),
        "a recording nobody waits for must not be written"
    );
}
