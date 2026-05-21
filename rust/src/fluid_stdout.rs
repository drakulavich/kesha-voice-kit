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
//!   diarization teardown `E5RT` print, which fires asynchronously after the
//!   call returns — a scoped guard can't catch it.

use std::io::Write;
use std::os::fd::OwnedFd;

/// Run `f` with the process's stdout temporarily redirected to `devnull`.
/// Restoring stdout in a `Drop` impl keeps the redirect short-lived even if `f`
/// panics. `devnull` is a caller-owned fd (the ASR hot path caches one on the
/// backend); passing `None` runs `f` with stdout untouched (best-effort fallback
/// when opening /dev/null failed).
pub(crate) fn with_silenced_stdout<R>(devnull: Option<&OwnedFd>, f: impl FnOnce() -> R) -> R {
    use std::os::fd::{AsRawFd, FromRawFd};

    struct StdoutGuard {
        saved: Option<OwnedFd>,
    }
    impl Drop for StdoutGuard {
        fn drop(&mut self) {
            if let Some(saved) = self.saved.take() {
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
                    let _ = writeln!(
                        std::io::stderr(),
                        "warning: failed to restore stdout after FluidAudio call: {errno}"
                    );
                }
            }
        }
    }

    // SAFETY: dup(STDOUT) returns a fresh fd we own; OwnedFd takes
    // responsibility for closing it on drop. dup failure is best-effort —
    // we just run f without a guard, never worse than the pre-#259
    // behaviour.
    let saved: Option<OwnedFd> = unsafe {
        let raw = libc::dup(libc::STDOUT_FILENO);
        if raw < 0 {
            None
        } else {
            Some(OwnedFd::from_raw_fd(raw))
        }
    };
    let have_save = saved.is_some();
    let _guard = StdoutGuard { saved };

    // Only redirect if we successfully saved stdout — otherwise dup2
    // would point fd 1 at /dev/null with no way to restore, silently
    // swallowing the engine's final JSON for the rest of the process.
    if have_save {
        if let Some(devnull) = devnull {
            // SAFETY: devnull is owned by the caller; dup2 atomically replaces
            // fd 1 with a duplicate of devnull, and the caller's fd stays valid.
            let rc = unsafe { libc::dup2(devnull.as_raw_fd(), libc::STDOUT_FILENO) };
            if rc < 0 {
                let errno = std::io::Error::last_os_error();
                let _ = writeln!(
                    std::io::stderr(),
                    "warning: failed to silence stdout before FluidAudio call: {errno}"
                );
            }
        }
    }
    f()
}

/// One-shot variant for non-hot-path FluidAudio calls (Kokoro synth,
/// diarization): opens `/dev/null` itself for the duration of `f`. A failed
/// open runs `f` with stdout untouched (best-effort). Wrap the FluidAudio
/// instance's *whole* lifetime (create → call → drop) so teardown-time CoreML
/// noise is silenced too.
#[cfg(any(feature = "system_kokoro", feature = "system_diarize"))]
pub(crate) fn with_silenced_stdout_oneshot<R>(f: impl FnOnce() -> R) -> R {
    let devnull: Option<OwnedFd> = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/null")
        .ok()
        .map(OwnedFd::from);
    with_silenced_stdout(devnull.as_ref(), f)
}

/// Permanently redirect the process's stdout to `/dev/null` and hand back a
/// handle to the *original* stdout for emitting the engine's real payload.
///
/// This exists for the diarization path. FluidAudio's Espresso runtime prints
/// `E5RT encountered an STL exception. msg = unordered_map::at: key not found.`
/// to stdout during **asynchronous CoreML model teardown** — *after* the
/// synchronous diarize call (and any scoped [`with_silenced_stdout`] guard) has
/// returned. A scoped guard structurally cannot catch a print that fires on a
/// background queue once it has already restored fd 1.
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
#[cfg(all(feature = "system_diarize", target_os = "macos"))]
pub(crate) struct StdoutShield {
    real_stdout: Option<std::fs::File>,
}

#[cfg(all(feature = "system_diarize", target_os = "macos"))]
impl StdoutShield {
    pub(crate) fn new() -> Self {
        use std::os::fd::{AsRawFd, FromRawFd};

        // SAFETY: dup(STDOUT) returns a fresh fd we own; File takes ownership and
        // closes it on drop. The original stdout (the pipe the parent reads) stays
        // referenced by this dup.
        let real_stdout: Option<std::fs::File> = unsafe {
            let raw = libc::dup(libc::STDOUT_FILENO);
            if raw < 0 {
                None
            } else {
                Some(std::fs::File::from_raw_fd(raw))
            }
        };

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
                    let _ = writeln!(
                        std::io::stderr(),
                        "warning: failed to shield stdout before diarization: {errno}"
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
