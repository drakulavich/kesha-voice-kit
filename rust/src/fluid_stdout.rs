//! Temporarily silence the process's stdout around FluidAudio (CoreML) calls.
//!
//! FluidAudio's CoreML pipeline occasionally writes diagnostics to stdout — via
//! Swift `print(...)` (`Transcribe error: invalidAudioData`, #259) or the
//! Espresso runtime (`E5RT encountered an STL exception...` during diarization).
//! When `kesha-engine` is emitting WAV bytes or `--json` to stdout, that noise
//! corrupts the output. Two strategies live here:
//!
//! - [`with_silenced_stdout`] / [`with_silenced_stdout_oneshot`] redirect fd 1
//!   to /dev/null for the duration of a closure and **restore** it in a `Drop`
//!   guard. Right for *synchronous* prints (ASR `invalidAudioData`, #259).
//! - [`StdoutShield`] redirects fd 1 to /dev/null and **never restores** it,
//!   emitting the real payload through a saved `dup`. Required for the
//!   asynchronous `E5RT` prints — diarization teardown, and anything CoreML
//!   emits between two streaming ASR calls — which fire after the call returns,
//!   where a scoped guard has already put fd 1 back.
//!
//! File descriptor 1 belongs to the whole process, not a Rust thread. The
//! internal ownership lock serializes every redirect/restore transition here;
//! while a scoped guard owns it, unrelated threads still must not write to
//! stdout because their bytes would be intentionally discarded. Worker callers
//! send progress over channels and leave reporting to the stdout-owning thread.

use crate::protocol::events;
use std::os::fd::OwnedFd;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Not reentrant: a nested call, or a FluidAudio callback that re-enters a
/// guard, hangs forever with no error and no log line.
fn stdout_ownership() -> MutexGuard<'static, ()> {
    static OWNER: OnceLock<Mutex<()>> = OnceLock::new();
    OWNER
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `dup` a descriptor into an owned handle, or `None` when the call failed.
/// Every caller here treats failure as best-effort: run unguarded rather than
/// point fd 1 somewhere it cannot be recovered from.
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

/// Run `f` with the process's stdout temporarily redirected to `devnull`.
/// Restoring stdout in a `Drop` impl keeps the redirect short-lived even if `f`
/// panics. `devnull` is a caller-owned fd (the ASR hot path caches one on the
/// backend); passing `None` runs `f` with stdout untouched (best-effort fallback
/// when opening /dev/null failed).
pub(crate) fn with_silenced_stdout<R>(devnull: Option<&OwnedFd>, f: impl FnOnce() -> R) -> R {
    use std::os::fd::AsRawFd;

    let _owner = stdout_ownership();

    struct StdoutGuard {
        saved: Option<OwnedFd>,
    }
    impl Drop for StdoutGuard {
        fn drop(&mut self) {
            if let Some(saved) = self.saved.take() {
                // Drain the C stdio buffer to /dev/null *before* restoring fd 1.
                // When stdout is a pipe/file (e.g. `say --stdin-loop`), libc makes
                // the FILE* fully buffered, so a synchronous Swift `print` from the
                // FluidAudio bridge sits in that buffer during the guarded scope and
                // would otherwise flush onto the *restored* real stdout afterwards —
                // corrupting the binary frame stream (#543). Flushing here, while fd 1
                // still points at /dev/null, discards that noise. Rust's own stdout
                // uses a separate buffer, so framed output is unaffected.
                // SAFETY: fflush(NULL) flushes all open C output streams; it takes no
                // borrows and is safe to call from a Drop impl.
                if unsafe { libc::fflush(std::ptr::null_mut()) } != 0 {
                    // Flush failed — residual Swift-bridge output may still flush onto
                    // the restored stdout below, recreating the #543 corruption. Writing
                    // to /dev/null should never fail, so this is a very low-probability
                    // path; warn on stderr to match the dup2 handling below.
                    let errno = std::io::Error::last_os_error();
                    events::warn(
                        events::W_GENERIC,
                        format!("warning: failed to flush stdout before restore after FluidAudio call: {errno}"),
                    );
                }
                // SAFETY: saved is a dup'd stdout fd we own. as_raw_fd
                // borrows it for the dup2 call (atomic in the kernel);
                // `saved` is then dropped at end of this block, closing
                // the duplicate. dup2 retains its own reference on fd 1.
                let rc = unsafe { libc::dup2(saved.as_raw_fd(), libc::STDOUT_FILENO) };
                if rc < 0 {
                    // Restore failed — fd 1 stays pointed at /dev/null and
                    // every subsequent `println!` (including our final JSON)
                    // silently vanishes. Surface the OS error on stderr so the
                    // caller has any chance of noticing the broken pipe.
                    // Rare path (fd exhaustion mid-run); we can't do better
                    // than warn from a Drop impl.
                    let errno = std::io::Error::last_os_error();
                    events::warn(
                        events::W_GENERIC,
                        format!("warning: failed to restore stdout after FluidAudio call: {errno}"),
                    );
                }
            }
        }
    }

    // A failed dup is best-effort: run f unguarded, never worse than pre-#259 behaviour.
    let saved = dup_owned(libc::STDOUT_FILENO);
    let have_save = saved.is_some();
    let _guard = StdoutGuard { saved };

    // Only redirect if we successfully saved stdout — otherwise dup2
    // would point fd 1 at /dev/null with no way to restore, silently
    // swallowing the engine's final JSON for the rest of the process.
    if have_save {
        if let Some(devnull) = devnull {
            // Flush real stdout before redirect so pre-buffered output isn't swallowed by /dev/null.
            // SAFETY: fflush(NULL) flushes all open C output streams; no borrows.
            if unsafe { libc::fflush(std::ptr::null_mut()) } != 0 {
                let errno = std::io::Error::last_os_error();
                events::warn(
                    events::W_GENERIC,
                    format!("warning: failed to flush stdout before silencing for FluidAudio call: {errno}"),
                );
            }
            // SAFETY: devnull is owned by the caller; dup2 atomically replaces
            // fd 1 with a duplicate of devnull, and the caller's fd stays valid.
            let rc = unsafe { libc::dup2(devnull.as_raw_fd(), libc::STDOUT_FILENO) };
            if rc < 0 {
                let errno = std::io::Error::last_os_error();
                events::warn(
                    events::W_GENERIC,
                    format!("warning: failed to silence stdout before FluidAudio call: {errno}"),
                );
            }
        }
    }
    f()
}

/// Where FluidAudio's stdout chatter goes while a silencing guard is held:
/// `/dev/null` normally, stderr under `KESHA_DEBUG`.
///
/// CoreML reports real failures — the ANE-less prepare error and the E5RT
/// exceptions behind it (#678) — on stdout, so discarding it unconditionally
/// makes those failures unreadable exactly where they matter: a CI runner you
/// cannot attach to. The ASR path is the same story: the bridge collapses every
/// `transcribeSamples` throw to a bare "Transcription failed" and prints the
/// underlying error with Swift `print`, so /dev/null is where #841's warm-cache
/// flake diagnosis went.
///
/// Scope of what this changes, precisely: only where fd 1 points *while the
/// guard is held*. Callers write their payload after it returns, so the
/// redirect never misroutes kesha's own output. It does **not** address the
/// hazard this module documents for the permanent-redirect variant — a
/// background CoreML print landing on real stdout after the guard restores
/// fd 1, which can still corrupt a streamed WAV. That is unchanged either way,
/// since `/dev/null` does not catch a post-restore print either.
#[cfg(any(
    feature = "coreml",
    feature = "system_kokoro",
    feature = "system_diarize"
))]
pub(crate) fn oneshot_sink() -> Option<OwnedFd> {
    if crate::debug::enabled() {
        if let Some(stderr) = dup_owned(libc::STDERR_FILENO) {
            return Some(stderr);
        }
    }
    std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/null")
        .ok()
        .map(OwnedFd::from)
}

/// One-shot variant for non-hot-path FluidAudio calls (Kokoro synth,
/// diarization). A failed open runs `f` with stdout untouched (best-effort).
/// Wrap the FluidAudio instance's *whole* lifetime (create → call → drop) so
/// teardown-time CoreML noise is captured too.
#[cfg(any(feature = "system_kokoro", feature = "system_diarize"))]
pub(crate) fn with_silenced_stdout_oneshot<R>(f: impl FnOnce() -> R) -> R {
    let sink = oneshot_sink();
    with_silenced_stdout(sink.as_ref(), f)
}

/// Permanently redirect the process's stdout to `/dev/null` and hand back a
/// handle to the *original* stdout for emitting the engine's real payload.
///
/// This exists for the FluidAudio paths that own stdout: diarization
/// (`transcribe --speakers`) and the live streaming ASR session
/// (`record --live`). FluidAudio's Espresso runtime prints `E5RT encountered an
/// STL exception. msg = unordered_map::at: key not found.` to stdout during
/// **asynchronous CoreML model teardown** — *after* the synchronous call (and
/// any scoped [`with_silenced_stdout`] guard) has returned. A scoped guard
/// structurally cannot catch a print that fires on a background queue once it
/// has already restored fd 1, nor one that fires between two guarded calls.
///
/// So this guard is deliberately one-way: it points fd 1 at `/dev/null` and
/// **never restores it**. The teardown print can fire arbitrarily late (even
/// during process exit), so restoring fd 1 would re-expose it on the real
/// stdout the parent reads. The caller writes its payload through
/// [`write_stdout`](Self::write_stdout) (the saved `dup`) and exits shortly
/// after; on drop the saved handle closes, signalling EOF to the parent.
///
/// If saving the original stdout fails, fd 1 is left untouched and
/// [`write_stdout`](Self::write_stdout) falls back to the process stdout —
/// best-effort, never worse than no shield (the teardown noise may leak, but we
/// never silently swallow the payload).
#[cfg(all(
    any(feature = "system_diarize", feature = "coreml"),
    target_os = "macos"
))]
pub(crate) struct StdoutShield {
    real_stdout: Option<std::fs::File>,
}

#[cfg(all(
    any(feature = "system_diarize", feature = "coreml"),
    target_os = "macos"
))]
impl StdoutShield {
    pub(crate) fn new() -> Self {
        use std::os::fd::AsRawFd;

        let _owner = stdout_ownership();

        // The original stdout — the pipe the parent reads — stays referenced by this dup.
        let real_stdout: Option<std::fs::File> =
            dup_owned(libc::STDOUT_FILENO).map(std::fs::File::from);

        // Only redirect fd 1 if we actually saved the real stdout — otherwise we'd
        // point fd 1 at /dev/null with no way to emit the payload.
        if real_stdout.is_some() {
            if let Ok(devnull) = std::fs::OpenOptions::new().write(true).open("/dev/null") {
                let devnull = OwnedFd::from(devnull);
                // SAFETY: dup2 atomically replaces fd 1 with a duplicate of devnull;
                // devnull's own fd is dropped at end of block, fd 1 keeps a reference.
                let rc = unsafe { libc::dup2(devnull.as_raw_fd(), libc::STDOUT_FILENO) };
                if rc < 0 {
                    let errno = std::io::Error::last_os_error();
                    events::warn(
                        events::W_GENERIC,
                        format!("warning: failed to shield stdout from FluidAudio: {errno}"),
                    );
                }
            }
        }

        Self { real_stdout }
    }

    /// Write the engine's real payload to the saved original stdout (unbuffered,
    /// flushed immediately). Falls back to the process stdout when the shield
    /// failed to save it.
    pub(crate) fn write_stdout(&self, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        if let Some(file) = self.real_stdout.as_ref() {
            // `&File` implements `Write`; write through a shared ref so we don't
            // need `&mut self` (the fd is owned by the File regardless).
            let mut f: &std::fs::File = file;
            f.write_all(bytes)?;
            f.flush()
        } else {
            let mut out = std::io::stdout().lock();
            out.write_all(bytes)?;
            out.flush()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek};
    use std::os::fd::{AsRawFd, OwnedFd};

    /// Restores the test's original fd even when an assert panics — under a
    /// single-process `cargo test --lib` run a leaked redirect would misdirect
    /// other tests' output.
    struct RestoreFd {
        saved: std::os::fd::RawFd,
        target: std::os::fd::RawFd,
    }
    impl Drop for RestoreFd {
        fn drop(&mut self) {
            // SAFETY: self.saved is the dup of the original fd we own.
            unsafe { libc::dup2(self.saved, self.target) };
            // SAFETY: dup2 kept its own reference on the target, so this drops only our copy.
            unsafe { libc::close(self.saved) };
        }
    }

    /// Point `target` at `capture`, handing back the guard that puts it back.
    fn redirect(target: std::os::fd::RawFd, capture: &std::fs::File) -> RestoreFd {
        let saved = dup_owned(target).expect("dup the fd under test");
        // SAFETY: dup2 atomically replaces target with a duplicate of the capture file.
        assert!(unsafe { libc::dup2(capture.as_raw_fd(), target) } >= 0);
        RestoreFd {
            saved: std::os::fd::IntoRawFd::into_raw_fd(saved),
            target,
        }
    }

    /// Write through C stdio, the way the FluidAudio bridge and the Espresso
    /// runtime do — buffered, so the guard's flush ordering is what is on test.
    fn c_print(msg: &core::ffi::CStr) {
        // SAFETY: msg is a NUL-terminated C string and the format string takes no arguments.
        unsafe { libc::printf(msg.as_ptr()) };
    }

    fn c_flush() {
        // SAFETY: fflush(NULL) flushes every open C output stream and borrows nothing.
        unsafe { libc::fflush(std::ptr::null_mut()) };
    }

    /// Drives the real guard, not `stdout_ownership` directly: deleting the lock
    /// from `with_silenced_stdout` lets the second thread run its closure while
    /// the first is still inside. `overlapped` turns that into a statement about
    /// ordering rather than about elapsed time, which the deadline alone cannot
    /// make.
    #[test]
    fn scoped_guards_serialize_stdout_ownership() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let inside = Arc::new(AtomicBool::new(false));
        let overlapped = Arc::new(AtomicBool::new(false));
        let (first_in_tx, first_in_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (attempting_tx, attempting_rx) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();

        let first = std::thread::spawn({
            let inside = Arc::clone(&inside);
            move || {
                with_silenced_stdout(None, || {
                    inside.store(true, Ordering::SeqCst);
                    first_in_tx.send(()).expect("report first guard");
                    release_rx.recv().expect("release first guard");
                    inside.store(false, Ordering::SeqCst);
                });
            }
        });
        first_in_rx.recv().expect("wait for first guard");

        let second = std::thread::spawn({
            let inside = Arc::clone(&inside);
            let overlapped = Arc::clone(&overlapped);
            move || {
                attempting_tx.send(()).expect("report second attempt");
                with_silenced_stdout(None, || {
                    if inside.load(Ordering::SeqCst) {
                        overlapped.store(true, Ordering::SeqCst);
                    }
                    entered_tx.send(()).expect("report second guard");
                });
            }
        });
        attempting_rx.recv().expect("wait for second attempt");
        let entered_early = entered_rx.recv_timeout(Duration::from_millis(100)).is_ok();

        release_tx.send(()).expect("release first guard");
        first.join().expect("first guard joins");
        if !entered_early {
            entered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("second guard enters after the first exits");
        }
        second.join().expect("second guard joins");
        assert!(
            !overlapped.load(Ordering::SeqCst) && !entered_early,
            "second guard ran its closure while the first still owned fd 1"
        );
    }

    /// #841: the bridge collapses every transcribe throw to "Transcription
    /// failed" and prints the real error with Swift `print`, so `KESHA_DEBUG`
    /// has to land that stdout on stderr — the coreml-regression lane sets it
    /// for exactly this, and /dev/null would keep the flake undiagnosable.
    #[cfg(any(
        feature = "coreml",
        feature = "system_kokoro",
        feature = "system_diarize"
    ))]
    #[test]
    fn debug_routes_silenced_chatter_to_stderr() {
        std::env::set_var("KESHA_DEBUG", "1");
        let mut capture = tempfile::tempfile().expect("capture tempfile");
        let _restore = redirect(libc::STDERR_FILENO, &capture);

        // Taken after the redirect: the sink dups whatever fd 2 points at now.
        let sink = oneshot_sink();
        with_silenced_stdout(sink.as_ref(), || {
            c_print(c"Transcribe samples error: simulated\n");
        });
        drop(_restore);

        let mut contents = String::new();
        capture.rewind().unwrap();
        capture.read_to_string(&mut contents).unwrap();
        assert!(
            contents.contains("Transcribe samples error"),
            "KESHA_DEBUG must route FluidAudio's stdout chatter to stderr, got {contents:?}"
        );
    }

    /// #543: a C-stdio write buffered inside the guarded scope (a Swift
    /// `print` from the FluidAudio bridge) must be flushed to /dev/null
    /// *before* fd 1 is restored — reordering the flush after the restore
    /// leaks it onto the real stdout and corrupts the frame stream.
    /// nextest runs each test in its own process, so rewiring fd 1 is safe.
    #[test]
    fn silenced_scope_discards_buffered_c_stdio_before_restore() {
        let mut capture = tempfile::tempfile().expect("capture tempfile");
        let _restore = redirect(libc::STDOUT_FILENO, &capture);

        let devnull = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .ok()
            .map(OwnedFd::from);
        with_silenced_stdout(devnull.as_ref(), || {
            c_print(c"leaky diagnostics\n");
        });
        c_print(c"after guard\n");
        c_flush();
        drop(_restore);

        let mut contents = String::new();
        capture.rewind().unwrap();
        capture.read_to_string(&mut contents).unwrap();
        assert!(
            !contents.contains("leaky"),
            "buffered print leaked onto restored stdout: {contents:?}"
        );
        assert!(
            contents.contains("after guard"),
            "post-guard output must reach the restored stdout: {contents:?}"
        );
    }

    /// The shield's whole point over a scoped guard: fd 1 stays on /dev/null for
    /// prints that fire *between* FluidAudio calls and *after* the shield itself
    /// is dropped (CoreML teardown runs on a background queue), while the
    /// payload still reaches the real stdout.
    #[cfg(all(
        any(feature = "system_diarize", feature = "coreml"),
        target_os = "macos"
    ))]
    #[test]
    fn shield_holds_fd1_through_drop() {
        let mut capture = tempfile::tempfile().expect("capture tempfile");
        let _restore = redirect(libc::STDOUT_FILENO, &capture);

        {
            let shield = StdoutShield::new();
            c_print(c"E5RT between calls\n");
            c_flush();
            shield.write_stdout(b"transcript\n").expect("write payload");
            c_print(c"E5RT at teardown\n");
            c_flush();
        }
        // Fires after the shield dropped, as a CoreML teardown print can.
        c_print(c"E5RT after drop\n");
        c_flush();
        drop(_restore);

        let mut contents = String::new();
        capture.rewind().unwrap();
        capture.read_to_string(&mut contents).unwrap();
        assert_eq!(
            contents, "transcript\n",
            "shielded stdout must carry only the payload"
        );
    }

    /// The shield holds the lock only across its descriptor swap, so what is on
    /// test is the entry: `new()` must not swap fd 1 out from under a live scoped
    /// guard. `RestoreFd` puts the real stdout back afterwards — the shield never
    /// does, by design.
    #[cfg(all(
        any(feature = "system_diarize", feature = "coreml"),
        target_os = "macos"
    ))]
    #[test]
    fn permanent_shield_waits_for_a_live_scoped_guard() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let capture = tempfile::tempfile().expect("capture tempfile");
        let _restore = redirect(libc::STDOUT_FILENO, &capture);

        let inside = Arc::new(AtomicBool::new(false));
        let overlapped = Arc::new(AtomicBool::new(false));
        let (holding_tx, holding_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (attempting_tx, attempting_rx) = mpsc::channel();
        let (built_tx, built_rx) = mpsc::channel();

        let holder = std::thread::spawn({
            let inside = Arc::clone(&inside);
            move || {
                with_silenced_stdout(None, || {
                    inside.store(true, Ordering::SeqCst);
                    holding_tx.send(()).expect("report holder");
                    release_rx.recv().expect("release holder");
                    inside.store(false, Ordering::SeqCst);
                });
            }
        });
        holding_rx.recv().expect("wait for holder");

        let builder = std::thread::spawn({
            let inside = Arc::clone(&inside);
            let overlapped = Arc::clone(&overlapped);
            move || {
                attempting_tx.send(()).expect("report shield attempt");
                let shield = StdoutShield::new();
                if inside.load(Ordering::SeqCst) {
                    overlapped.store(true, Ordering::SeqCst);
                }
                built_tx.send(()).expect("report shield built");
                shield
            }
        });
        attempting_rx.recv().expect("wait for shield attempt");
        let built_early = built_rx.recv_timeout(Duration::from_millis(100)).is_ok();

        release_tx.send(()).expect("release holder");
        holder.join().expect("holder joins");
        if !built_early {
            built_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("shield builds once the scoped guard exits");
        }
        let shield = builder.join().expect("builder joins");
        drop(shield);
        drop(_restore);

        assert!(
            !overlapped.load(Ordering::SeqCst) && !built_early,
            "StdoutShield::new swapped fd 1 while a scoped guard still owned it"
        );
    }
}
