//! Capture fd 2 across a FluidAudio call so no library line reaches the CLI as a non-event (#1214, T1-14).

use crate::protocol::events;
use std::io::{Read, Seek};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};

/// A captured line is the library's, not ours; the cap keeps a 5 kB input from being echoed back.
const MAX_LINE_CHARS: usize = 200;

/// How long dropping the last relay waits for its reader to drain: a child that inherited fd 2 can hold the pipe open.
const RELAY_DRAIN: std::time::Duration = std::time::Duration::from_secs(2);

/// Serializes every fd 2 transition. A capture holds it for its whole call; a live relay only while it swaps fd 2.
#[derive(Default)]
struct Owner {
    relays: usize,
    relay: Option<Installed>,
}

struct Installed {
    saved: OwnedFd,
    drained: mpsc::Receiver<()>,
}

fn stderr_ownership() -> MutexGuard<'static, Owner> {
    static OWNER: OnceLock<Mutex<Owner>> = OnceLock::new();
    OWNER
        .get_or_init(|| Mutex::new(Owner::default()))
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

    // Losing the library's lines beats letting them reach the CLI raw, so an unwritable temp dir falls back to /dev/null.
    let capture = capture_file();
    let dropped = capture.is_none();
    let fallback = || {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/null")
            .ok()
    };
    let Some(mut file) = capture.or_else(fallback) else {
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
    if dropped {
        events::warn(
            events::W_GENERIC,
            format!(
                "FluidAudio's stderr was not captured (no capture file could be created in {}); anything it wrote there was discarded",
                std::env::temp_dir().display()
            ),
        );
    }

    let mut captured = String::new();
    if file.rewind().is_ok() {
        let _ = file.read_to_string(&mut captured);
    }
    (result, captured)
}

/// Rendered form of one line fd 2 received: ours verbatim, a library line as one warn event.
fn relayed_line(line: &str) -> Option<String> {
    let line = line.trim_end();
    if line.is_empty() {
        return None;
    }
    if is_event_line(line) {
        return Some(line.to_string());
    }
    Some(events::Event::warn(events::W_GENERIC, truncated(line)).render())
}

fn is_event_line(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    let is_string = |key: &str| object.get(key).is_some_and(serde_json::Value::is_string);
    let optional_string = |key: &str| object.get(key).is_none_or(serde_json::Value::is_string);
    match object.get("kind").and_then(serde_json::Value::as_str) {
        Some("progress") => {
            is_string("message")
                && optional_string("phase")
                && object
                    .get("pct")
                    .is_none_or(|pct| pct.as_u64().is_some_and(|pct| pct <= 100))
        }
        Some("warn" | "error") => is_string("code") && is_string("message"),
        Some("debug") => {
            object.get("t_ms").is_some_and(serde_json::Value::is_number)
                && is_string("message")
                && optional_string("event")
        }
        _ => false,
    }
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
    for rendered in captured.lines().filter_map(relayed_line) {
        events::emit_rendered(&rendered);
    }
}

/// Put back only our own events: the library's lines ride in the coded error instead.
pub(crate) fn relay_events_only(captured: &str) {
    for line in captured.lines().map(str::trim_end) {
        if is_event_line(line) {
            events::emit_rendered(line);
        }
    }
}

/// A FluidAudio call whose own logger writes to fd 2: its lines come back as warn events on success, inside the error on failure (#1301).
pub(crate) fn with_relayed_stderr<T>(f: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    let (result, captured) = with_captured_stderr(f);
    match result {
        Ok(value) => {
            relay_captured(&captured);
            Ok(value)
        }
        Err(err) => {
            relay_events_only(&captured);
            let detail = failure_detail(&captured);
            Err(if detail.is_empty() {
                err
            } else {
                err.context(format!("FluidAudio reported{detail}"))
            })
        }
    }
}

/// The last library line, as a suffix for the error the failed call returns: after a retry or two, that is the one that says why it gave up.
pub(crate) fn failure_detail(captured: &str) -> String {
    captured
        .lines()
        .map(str::trim_end)
        .rfind(|l| !l.is_empty() && !is_event_line(l))
        .map(|l| format!(" ({})", truncated(l)))
        .unwrap_or_default()
}

/// Holds fd 2 on a pipe while alive; a reader thread re-emits each line the moment it lands (#1316).
///
/// For spans too long to capture to a file and read afterwards — a live session, a diarization run —
/// because that would hold back the engine's own progress events until the span ends. Relays nest:
/// fd 2 goes back when the last one drops. Never start one inside [`with_captured_stderr`]'s closure,
/// which holds the lock this needs.
pub(crate) struct StderrRelay(());

impl StderrRelay {
    pub(crate) fn start() -> Self {
        let mut owner = stderr_ownership();
        owner.relays += 1;
        if owner.relays == 1 {
            match install_relay() {
                Ok(installed) => owner.relay = Some(installed),
                Err(err) => events::warn(
                    events::W_GENERIC,
                    format!("FluidAudio's stderr is not being relayed ({err}); a line it logs may reach the CLI raw"),
                ),
            }
        }
        StderrRelay(())
    }
}

impl Drop for StderrRelay {
    fn drop(&mut self) {
        let mut owner = stderr_ownership();
        owner.relays -= 1;
        if owner.relays > 0 {
            return;
        }
        if let Some(Installed { saved, drained }) = owner.relay.take() {
            // SAFETY: fflush(NULL) flushes every open C output stream and borrows nothing.
            unsafe { libc::fflush(std::ptr::null_mut()) };
            // SAFETY: saved is a dup'd fd 2 we own; dup2 is atomic, and dropping fd 2's pipe reference lets the reader see EOF.
            unsafe { libc::dup2(saved.as_raw_fd(), libc::STDERR_FILENO) };
            let _ = drained.recv_timeout(RELAY_DRAIN);
        }
    }
}

fn install_relay() -> std::io::Result<Installed> {
    let (reader, writer) = std::io::pipe()?;
    let saved = dup_owned(libc::STDERR_FILENO).ok_or_else(std::io::Error::last_os_error)?;
    let mut out = std::fs::File::from(saved.try_clone()?);
    let (drained_tx, drained) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("fluid-stderr-relay".into())
        .spawn(move || {
            let _drained = drained_tx;
            relay_stream(std::io::BufReader::new(reader), &mut out);
        })?;
    // SAFETY: dup2 atomically points fd 2 at the pipe's write end; `writer` drops below, so fd 2 holds the only one.
    if unsafe { libc::dup2(writer.as_raw_fd(), libc::STDERR_FILENO) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(Installed { saved, drained })
}

/// Bytes of one line the relay holds; the rest is drained unread, since only [`MAX_LINE_CHARS`] of it is re-emitted.
const MAX_RELAY_LINE_BYTES: u64 = 4096;

/// A failed write keeps reading, so a library blocked on a full pipe is never stranded.
fn relay_stream(mut reader: impl std::io::BufRead, out: &mut impl std::io::Write) {
    use std::io::{BufRead, Read};
    let mut chunk = Vec::new();
    loop {
        chunk.clear();
        match (&mut reader)
            .take(MAX_RELAY_LINE_BYTES)
            .read_until(b'\n', &mut chunk)
        {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if chunk.last() != Some(&b'\n') && chunk.len() as u64 == MAX_RELAY_LINE_BYTES {
            let _ = reader.skip_until(b'\n');
        }
        for rendered in String::from_utf8_lossy(&chunk)
            .lines()
            .filter_map(relayed_line)
        {
            let _ = events::write_line(out, &rendered);
        }
    }
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

    /// Reads back what a relay wrote by pointing fd 2 at a file for the duration.
    fn relayed(f: impl FnOnce()) -> String {
        let mut capture = tempfile::tempfile().expect("capture tempfile");
        let saved = dup_owned(libc::STDERR_FILENO).expect("dup fd 2");
        // SAFETY: dup2 atomically points fd 2 at the capture file this test owns.
        assert!(unsafe { libc::dup2(capture.as_raw_fd(), libc::STDERR_FILENO) } >= 0);
        f();
        // SAFETY: fflush(NULL) flushes every open C output stream, so a buffered library line lands before the read.
        unsafe { libc::fflush(std::ptr::null_mut()) };
        // SAFETY: saved is our dup of the original fd 2; dup2 keeps its own reference.
        unsafe { libc::dup2(saved.as_raw_fd(), libc::STDERR_FILENO) };
        let mut contents = String::new();
        capture.rewind().expect("rewind capture");
        capture.read_to_string(&mut contents).expect("read capture");
        contents
    }

    #[test]
    fn a_library_line_comes_back_as_one_warn_event_and_ours_comes_back_verbatim() {
        let captured =
            "{\"kind\":\"debug\",\"t_ms\":1,\"message\":\"ours\"}\nKokoro synthesize error: boom\n";
        let out = relayed(|| relay_captured(captured));
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2, "{out:?}");
        assert_eq!(
            lines[0],
            "{\"kind\":\"debug\",\"t_ms\":1,\"message\":\"ours\"}"
        );
        let v: serde_json::Value =
            serde_json::from_str(lines[1]).expect("the library line is wrapped in an event");
        assert_eq!(v["kind"], "warn");
        assert_eq!(v["message"], "Kokoro synthesize error: boom");

        let only_ours = relayed(|| relay_events_only(captured));
        assert_eq!(
            only_ours.trim(),
            "{\"kind\":\"debug\",\"t_ms\":1,\"message\":\"ours\"}",
            "a failed call keeps the library line out of stderr"
        );
    }

    #[test]
    fn a_library_line_that_only_looks_like_an_event_is_wrapped() {
        for input in ["{\"kind\":not-json", "{\"kind\":\"progress\"}"] {
            let out = relayed(|| relay_captured(input));
            let line = out.trim();
            let event: serde_json::Value = serde_json::from_str(line).expect("one protocol event");
            assert_eq!(event["kind"], "warn");
            assert_eq!(event["message"], input);
        }
    }

    /// #1301: a download retry FluidAudio recovered from reached the CLI as raw fd 2 prose and failed `kesha install`.
    #[test]
    fn a_fluidaudio_log_line_from_a_call_that_succeeds_becomes_one_warn_event() {
        let raw = "[WARN] [FluidAudio.DownloadUtils] Download attempt 1 for parakeet failed: The network connection was lost.. Retrying in 1.0s.";
        let mut returned = None;
        let out = relayed(|| {
            returned = Some(with_relayed_stderr(|| {
                c_print_stderr(c"[WARN] [FluidAudio.DownloadUtils] Download attempt 1 for parakeet failed: The network connection was lost.. Retrying in 1.0s.\n");
                Ok(5)
            }));
        });
        assert_eq!(returned.expect("ran").expect("the call succeeded"), 5);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 1, "{out:?}");
        let v: serde_json::Value =
            serde_json::from_str(lines[0]).expect("the library line is wrapped in an event");
        assert_eq!(v["kind"], "warn");
        assert_eq!(v["message"], raw);
    }

    /// An unwritable temp dir must not let the library line through raw (Codex on #1312).
    #[test]
    fn a_capture_file_that_cannot_be_created_still_keeps_library_lines_off_stderr() {
        let mut returned = None;
        let out = relayed(|| {
            std::env::set_var("TMPDIR", "/nonexistent/kesha-fluid-stderr");
            returned = Some(with_relayed_stderr(|| {
                c_print_stderr(c"[WARN] [FluidAudio.DownloadUtils] Retrying in 1.0s.\n");
                Ok(1)
            }));
        });
        assert_eq!(returned.expect("ran").expect("the call succeeded"), 1);
        assert!(
            !out.contains("[WARN]"),
            "a raw library line reached stderr: {out:?}"
        );
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(
            lines.len(),
            1,
            "one warning says the capture failed: {out:?}"
        );
        let v: serde_json::Value = serde_json::from_str(lines[0]).expect("an event");
        assert_eq!(v["kind"], "warn");
        assert!(
            v["message"]
                .as_str()
                .is_some_and(|m| m.contains("FluidAudio's stderr was not captured")),
            "{v}"
        );
    }

    #[test]
    fn a_fluidaudio_log_line_from_a_call_that_fails_rides_in_the_error() {
        let mut returned = None;
        let out = relayed(|| {
            returned = Some(with_relayed_stderr::<()>(|| {
                c_print_stderr(
                    c"[WARN] [FluidAudio.DownloadUtils] Download attempt 1 failed. Retrying in 1.0s.\n",
                );
                c_print_stderr(
                    c"[ERROR] [FluidAudio.DownloadUtils] Download failed after 3 attempts\n",
                );
                Err(anyhow::anyhow!("failed to initialize FluidAudio ASR"))
            }));
        });
        let err = returned.expect("ran").expect_err("the call failed");
        assert!(
            format!("{err:#}").contains("Download failed after 3 attempts"),
            "the terminal line explains the failure, not the first retry: {err:#}"
        );
        assert!(out.trim().is_empty(), "no raw line reaches stderr: {out:?}");
    }

    #[test]
    fn the_failure_detail_skips_our_own_events() {
        let captured = "{\"kind\":\"warn\",\"code\":\"W_GENERIC\",\"message\":\"ours\"}\nKokoro synthesize error: boom\n";
        assert_eq!(failure_detail(captured), " (Kokoro synthesize error: boom)");
        assert_eq!(failure_detail("\n\n"), "");
    }

    /// #1316: a sliding-window failure logs on FluidAudio's background task, long after init returned.
    #[test]
    fn a_library_line_written_while_a_relay_is_held_becomes_one_warn_event() {
        let raw = "[ERROR] [FluidAudio.SlidingWindowAsrManager] Model processing error (window failure #1): boom";
        let out = relayed(|| {
            let relay = StderrRelay::start();
            c_print_stderr(c"[ERROR] [FluidAudio.SlidingWindowAsrManager] Model processing error (window failure #1): boom\n");
            drop(relay);
        });
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 1, "{out:?}");
        let v: serde_json::Value =
            serde_json::from_str(lines[0]).expect("the library line is wrapped in an event");
        assert_eq!(v["kind"], "warn");
        assert_eq!(v["message"], raw);
    }

    /// #1316: the relay spans a whole live session, so our own progress must not wait for it to end.
    #[test]
    fn our_event_reaches_stderr_while_the_relay_is_still_held() {
        let capture = tempfile::NamedTempFile::new().expect("capture file");
        let saved = dup_owned(libc::STDERR_FILENO).expect("dup fd 2");
        // SAFETY: dup2 atomically points fd 2 at the capture file this test owns.
        assert!(unsafe { libc::dup2(capture.as_file().as_raw_fd(), libc::STDERR_FILENO) } >= 0);

        let relay = StderrRelay::start();
        events::progress(None, "Listening... 1s");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains('\n') {
            std::thread::sleep(std::time::Duration::from_millis(10));
            seen = std::fs::read_to_string(capture.path()).expect("read capture");
        }
        drop(relay);
        // SAFETY: saved is our dup of the original fd 2; dup2 keeps its own reference.
        unsafe { libc::dup2(saved.as_raw_fd(), libc::STDERR_FILENO) };

        assert_eq!(
            seen, "{\"kind\":\"progress\",\"message\":\"Listening... 1s\"}\n",
            "the event must land while the relay is held, verbatim"
        );
    }

    #[test]
    fn a_nested_relay_keeps_relaying_until_the_outer_one_ends() {
        let out = relayed(|| {
            let outer = StderrRelay::start();
            drop(StderrRelay::start());
            c_print_stderr(c"[WARN] [FluidAudio.Sortformer] after the inner relay ended\n");
            drop(outer);
        });
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 1, "{out:?}");
        let v: serde_json::Value = serde_json::from_str(lines[0]).expect("an event");
        assert_eq!(v["kind"], "warn");
    }

    #[test]
    fn a_line_longer_than_the_relay_holds_is_capped_and_the_next_line_still_relays() {
        let mut input = "x".repeat(1 << 20);
        input.push_str("\n[WARN] [FluidAudio.Sortformer] next\n");
        let mut out = Vec::new();
        relay_stream(std::io::Cursor::new(input), &mut out);
        let out = String::from_utf8(out).expect("utf-8");
        let lines: Vec<serde_json::Value> = out
            .lines()
            .map(|l| serde_json::from_str(l).expect("an event"))
            .collect();
        assert_eq!(lines.len(), 2, "{out:?}");
        assert_eq!(
            lines[0]["message"].as_str().map(|m| m.chars().count()),
            Some(MAX_LINE_CHARS + 1)
        );
        assert_eq!(lines[1]["message"], "[WARN] [FluidAudio.Sortformer] next");
    }
}
