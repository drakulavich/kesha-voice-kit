//! Capture fd 2 across a FluidAudio call so no library line reaches the CLI as a non-event (#1214, T1-14).

use crate::protocol::events;
use std::io::{Read, Seek};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// A captured line is the library's, not ours; the cap keeps a 5 kB input from being echoed back.
const MAX_LINE_CHARS: usize = 200;

fn stderr_ownership() -> MutexGuard<'static, ()> {
    static OWNER: OnceLock<Mutex<()>> = OnceLock::new();
    OWNER
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn dup_owned(fd: std::os::fd::RawFd) -> Option<OwnedFd> {
    use std::os::fd::FromRawFd;
    // SAFETY: dup either returns a fresh descriptor this process owns, or -1.
    let raw = unsafe { libc::dup(fd) };
    if raw < 0 {
        return None;
    }
    // SAFETY: raw came from the dup above, so OwnedFd is its sole owner and closes it on drop.
    Some(unsafe { OwnedFd::from_raw_fd(raw) })
}

/// Unlinked immediately: the descriptor keeps it alive, so a crash mid-call leaves nothing behind.
fn capture_file() -> Option<std::fs::File> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
        "kesha-fluid-stderr-{}-{nanos:x}",
        std::process::id()
    ));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()?;
    let _ = std::fs::remove_file(&path);
    Some(file)
}

/// Run `f` with fd 2 pointed at a scratch file, returning its result and whatever the call wrote there.
pub(crate) fn with_captured_stderr<R>(f: impl FnOnce() -> R) -> (R, String) {
    let _owner = stderr_ownership();

    struct StderrGuard {
        saved: Option<OwnedFd>,
    }
    impl Drop for StderrGuard {
        fn drop(&mut self) {
            if let Some(saved) = self.saved.take() {
                // SAFETY: fflush(NULL) flushes every open C output stream and borrows nothing.
                unsafe { libc::fflush(std::ptr::null_mut()) };
                // SAFETY: saved is a dup'd fd 2 we own; dup2 is atomic and keeps its own reference on fd 2.
                unsafe { libc::dup2(saved.as_raw_fd(), libc::STDERR_FILENO) };
            }
        }
    }

    let Some(mut file) = capture_file() else {
        return (f(), String::new());
    };
    let saved = dup_owned(libc::STDERR_FILENO);
    let redirected = saved.is_some();
    let guard = StderrGuard { saved };
    if redirected {
        // SAFETY: dup2 atomically replaces fd 2 with a duplicate of the capture file, which outlives the call.
        unsafe { libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO) };
    }

    let result = f();
    drop(guard);

    let mut captured = String::new();
    if file.rewind().is_ok() {
        let _ = file.read_to_string(&mut captured);
    }
    (result, captured)
}

fn truncated(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line.to_string();
    }
    let head: String = line.chars().take(MAX_LINE_CHARS).collect();
    format!("{head}…")
}

/// Re-emit what the call wrote: our own events verbatim, a library line as one warn event.
pub(crate) fn relay_captured(captured: &str) {
    for line in captured.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("{\"kind\":") {
            events::emit_rendered(line);
            continue;
        }
        events::warn(events::W_GENERIC, truncated(line));
    }
}

/// The first library line, as a suffix for the coded error the failed call returns.
pub(crate) fn failure_detail(captured: &str) -> String {
    captured
        .lines()
        .map(str::trim_end)
        .find(|l| !l.is_empty() && !l.starts_with("{\"kind\":"))
        .map(|l| format!(" ({})", truncated(l)))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c_print_stderr(msg: &core::ffi::CStr) {
        // SAFETY: msg is a NUL-terminated C string and the format string takes no arguments.
        unsafe { libc::fprintf(libc_stderr(), msg.as_ptr()) };
    }

    fn libc_stderr() -> *mut libc::FILE {
        // SAFETY: fdopen on a descriptor this process owns; the stream is flushed by the guard and leaked deliberately.
        unsafe { libc::fdopen(libc::STDERR_FILENO, c"w".as_ptr()) }
    }

    #[test]
    fn a_library_line_written_to_fd_2_is_returned_instead_of_reaching_stderr() {
        let (returned, captured) = with_captured_stderr(|| {
            c_print_stderr(c"[WARN] [FluidAudio.Kokoro] G2P failed on word 'xyz'\n");
            7
        });
        assert_eq!(returned, 7);
        assert!(
            captured.contains("G2P failed on word 'xyz'"),
            "{captured:?}"
        );
    }

    #[test]
    fn a_long_library_line_is_capped_before_it_is_re_emitted() {
        let line = "x".repeat(5_000);
        let capped = truncated(&line);
        assert_eq!(capped.chars().count(), MAX_LINE_CHARS + 1);
        assert!(capped.ends_with('…'));
    }

    #[test]
    fn the_failure_detail_skips_our_own_events() {
        let captured = "{\"kind\":\"warn\",\"code\":\"W_GENERIC\",\"message\":\"ours\"}\nKokoro synthesize error: boom\n";
        assert_eq!(failure_detail(captured), " (Kokoro synthesize error: boom)");
        assert_eq!(failure_detail("\n\n"), "");
    }
}
