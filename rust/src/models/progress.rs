use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Below this a download finishes fast enough that a bar is noise, not feedback.
pub(super) const PROGRESS_MIN_BYTES: u64 = 16 * 1024 * 1024;
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
const PROGRESS_BAR_WIDTH: usize = 20;

static DOWNLOADS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
/// `true` while a bar repaint has left the cursor mid-row. Guarded by the same lock
/// as the writes themselves, so ownership of the row transfers atomically.
static BAR_LINE_OPEN: Mutex<bool> = Mutex::new(false);

fn lock_stderr() -> std::sync::MutexGuard<'static, bool> {
    BAR_LINE_OPEN.lock().unwrap_or_else(|e| e.into_inner())
}

fn end_open_bar_line(open: &mut bool) {
    if *open {
        eprintln!();
        *open = false;
    }
}

/// Serializes install-progress writes and ends any open bar row first: the bar paints
/// with `\r` and no newline, so an `eprintln!` would otherwise land inside that row.
pub(super) fn with_stderr<T>(write: impl FnOnce() -> T) -> T {
    let mut open = lock_stderr();
    end_open_bar_line(&mut open);
    write()
}

/// Counts concurrent `download_verified` network phases so the bar can tell whether it owns stderr.
pub(super) struct InFlight;

impl InFlight {
    pub(super) fn new() -> Self {
        DOWNLOADS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        DOWNLOADS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Redraws a single `\r` line as bytes arrive (#680). Silent unless stderr is a
/// terminal, so redirected installs and CI logs keep the plain `GET`/`OK` lines.
///
/// Draws only while it is the sole download in flight: `parallel_download` runs
/// 4 rayon workers over one stderr, and concurrent bars plus other workers'
/// `GET`/`OK` lines would overwrite each other (Greptile P1 on #681). That still
/// covers the case this exists for — the 2.4GB encoder outlives every sibling by
/// minutes, so the long silent stretch is exactly when the bar is alone.
pub(super) struct ProgressReader<R> {
    inner: R,
    total: u64,
    read: u64,
    last_draw: std::time::Instant,
}

impl<R: io::Read> ProgressReader<R> {
    pub(super) fn new(inner: R, total: u64) -> Self {
        Self {
            inner,
            total,
            read: 0,
            last_draw: std::time::Instant::now(),
        }
    }

    fn draw(&mut self) {
        let mut open = lock_stderr();
        if DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst) != 1 {
            end_open_bar_line(&mut open);
            return;
        }
        let pct = ((self.read.min(self.total) as f64 / self.total as f64) * 100.0) as usize;
        let filled = pct * PROGRESS_BAR_WIDTH / 100;
        // No file name — a deep path wraps the line, and then `\r` can't repaint it (Greptile P2 on #681).
        eprint!(
            "\r    [{}{}] {:>3}%  {:.1}/{:.1}MB",
            "█".repeat(filled),
            "░".repeat(PROGRESS_BAR_WIDTH - filled),
            pct,
            self.read as f64 / 1_048_576.0,
            self.total as f64 / 1_048_576.0,
        );
        let _ = io::Write::flush(&mut io::stderr());
        *open = true;
    }
}

impl<R: io::Read> io::Read for ProgressReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        if n == 0 || self.last_draw.elapsed() >= PROGRESS_INTERVAL {
            self.draw();
            self.last_draw = std::time::Instant::now();
        }
        Ok(n)
    }
}

/// End the line here, not at EOF, so a mid-download bail prints its error on a fresh row.
impl<R> Drop for ProgressReader<R> {
    fn drop(&mut self) {
        end_open_bar_line(&mut lock_stderr());
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn progress_reader_is_byte_transparent() {
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let mut out = Vec::new();
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
        reader.read_to_end(&mut out).expect("read");
        assert_eq!(out, payload);
    }

    #[test]
    fn in_flight_guard_balances() {
        assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 0);
        {
            let _outer = InFlight::new();
            assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 1);
            let _inner = InFlight::new();
            assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 2);
        }
        assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 0);
    }

    /// The bar must stay silent unless it owns stderr — 4 rayon workers share it (#681 P1).
    #[test]
    fn bar_draws_only_when_alone() {
        let payload = vec![7u8; 512];
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
        let _a = InFlight::new();
        let _b = InFlight::new();
        reader.draw();
        assert!(!*lock_stderr(), "must not draw beside another download");

        drop(_b);
        reader.read = payload.len() as u64;
        reader.draw();
        assert!(*lock_stderr(), "must draw when it is the only download");
    }

    /// A sibling's `GET`/`OK` must not land inside the bar's open `\r` row (grok review on #681).
    #[test]
    fn sibling_write_ends_the_open_bar_row() {
        let payload = vec![7u8; 512];
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
        let _alone = InFlight::new();
        reader.draw();
        assert!(*lock_stderr(), "bar row is open");

        with_stderr(|| {});
        assert!(!*lock_stderr(), "a non-bar write must close the row first");
    }

    #[test]
    fn dropping_the_reader_ends_the_open_bar_row() {
        let payload = vec![7u8; 512];
        let _alone = InFlight::new();
        {
            let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
            reader.draw();
            assert!(*lock_stderr(), "bar row is open");
        }
        assert!(!*lock_stderr(), "drop must close the row");
    }
}
