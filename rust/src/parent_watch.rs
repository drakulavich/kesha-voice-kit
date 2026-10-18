//! Ends `transcribe` and `say` with exit 129 once the process that started them is gone (#1470).

#[cfg(unix)]
static PARENT: std::sync::OnceLock<i32> = std::sync::OnceLock::new();

/// SIGKILL on the caller signals nothing and a sibling may keep stdin open, so the parent pid is the only sign it is gone.
#[cfg(unix)]
pub fn exit_when_parent_exits() {
    // SAFETY: getppid takes no arguments and cannot fail.
    let _ = PARENT.set(unsafe { libc::getppid() });
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        exit_if_parent_exited();
    });
}

#[cfg(unix)]
pub fn exit_if_parent_exited() {
    let Some(&parent) = PARENT.get() else {
        return;
    };
    // SAFETY: as above.
    if unsafe { libc::getppid() } != parent {
        std::process::exit(129);
    }
}

#[cfg(not(unix))]
pub fn exit_when_parent_exits() {}

#[cfg(not(unix))]
pub fn exit_if_parent_exited() {}
