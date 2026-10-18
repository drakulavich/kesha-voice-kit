//! #1470: each engine waits on a FIFO a sibling holds open, so only the parent watch can end it.
#![cfg(unix)]
mod common;
use std::process::Command;

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 delivers nothing; it only asks whether the pid exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Starts the engine under a shell that is then SIGKILLed; `engine_args` may name `{fifo}`.
fn engine_outlives_killed_parent(dir: &std::path::Path, engine_args: &str) -> bool {
    let fifo = dir.join("held.fifo");
    let pid_file = dir.join("engine.pid");
    let holder_pid_file = dir.join("holder.pid");
    let script = dir.join("run.sh");
    let engine_args = engine_args.replace("{fifo}", &fifo.display().to_string());
    std::fs::write(
        &script,
        format!(
            "mkfifo '{fifo}'\n\
             sleep 30 > '{fifo}' &\n\
             echo $! > '{holder}'\n\
             sh -c '\"{engine}\" {engine_args} 2>/dev/null & echo $! > \"{pid}\"; sleep 1; kill -9 $$'\n",
            fifo = fifo.display(),
            holder = holder_pid_file.display(),
            engine = common::engine_bin(),
            pid = pid_file.display(),
        ),
    )
    .unwrap();
    Command::new("sh")
        .arg(&script)
        .status()
        .expect("run orchestrator");
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
    if let Ok(h) = std::fs::read_to_string(&holder_pid_file) {
        if let Ok(h) = h.trim().parse::<i32>() {
            // SAFETY: the pid was written by this test's own shell; nothing else is signalled.
            unsafe { libc::kill(h, libc::SIGKILL) };
        }
    }
    if !stopped {
        // SAFETY: the pid was spawned by this test's shell; nothing else is signalled.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    !stopped
}

#[test]
fn a_transcription_whose_parent_dies_stops_within_two_seconds() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        !engine_outlives_killed_parent(dir.path(), "transcribe \"{fifo}\" </dev/null"),
        "the engine kept transcribing after its parent died"
    );
}

#[cfg(feature = "tts")]
#[test]
fn a_synthesis_whose_parent_dies_stops_within_two_seconds_and_writes_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("orphan.wav");
    let args = format!("say --out \"{}\" <\"{{fifo}}\"", wav.display());
    assert!(
        !engine_outlives_killed_parent(dir.path(), &args),
        "the engine kept synthesizing after its parent died"
    );
    assert!(!wav.exists(), "a file nobody waits for must not be written");
}
