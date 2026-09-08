use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::protocol::events;

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
        events::progress(None, "");
        *open = false;
    }
}

/// Serializes install-progress writes and ends any open bar row first: the bar paints
/// with `\r` and no newline, so a stray write would otherwise land inside that row.
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

/// Redraws a single `\r` line as bytes arrive (#680). Silent unless stderr is a terminal on
/// protocol 3, so redirected installs, CI logs and v4 consumers keep parseable lines.
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
    label: String,
    last_draw: std::time::Instant,
}

/// A v4 consumer wants events whatever stderr is; the v3 bar can only repaint a terminal.
pub(super) fn reader_wanted(mode: events::Mode, stderr_is_terminal: bool, total: u64) -> bool {
    total >= PROGRESS_MIN_BYTES && (mode == events::Mode::V4 || stderr_is_terminal)
}

/// A v4 consumer parses events and renders its own progress, so the `\r` row would be noise it cannot parse.
fn bar_paints(mode: events::Mode, in_flight: usize) -> bool {
    mode == events::Mode::V3 && in_flight == 1
}

impl<R: io::Read> ProgressReader<R> {
    pub(super) fn new(inner: R, total: u64, label: impl Into<String>) -> Self {
        Self {
            inner,
            total,
            read: 0,
            label: label.into(),
            last_draw: std::time::Instant::now(),
        }
    }

    fn pct(&self) -> usize {
        ((self.read.min(self.total) as f64 / self.total as f64) * 100.0) as usize
    }

    /// Same in-flight rule as the bar: the consumer renders one line per event and cannot tell four downloads apart.
    fn progress_event(
        &self,
        mode: events::Mode,
        in_flight: usize,
    ) -> Option<events::Event<'static>> {
        if mode != events::Mode::V4 || in_flight != 1 {
            return None;
        }
        Some(events::Event::progress_pct(
            Some("download"),
            format!(
                "{} {:.1}/{:.1}MB",
                self.label,
                self.read as f64 / 1_048_576.0,
                self.total as f64 / 1_048_576.0
            ),
            self.pct() as u8,
        ))
    }

    fn draw(&mut self) {
        let mut open = lock_stderr();
        let mode = events::mode();
        let in_flight = DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst);
        if let Some(event) = self.progress_event(mode, in_flight) {
            event.emit();
            return;
        }
        if !bar_paints(mode, in_flight) {
            end_open_bar_line(&mut open);
            return;
        }
        let pct = self.pct();
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
    fn the_bar_paints_only_for_a_lone_download_on_protocol_3() {
        assert!(bar_paints(events::Mode::V3, 1));
        assert!(!bar_paints(events::Mode::V4, 1));
        assert!(!bar_paints(events::Mode::V3, 2));
        assert!(!bar_paints(events::Mode::V4, 2));
    }

    #[test]
    fn the_reader_is_wanted_on_protocol_4_without_a_terminal() {
        assert!(reader_wanted(events::Mode::V4, false, PROGRESS_MIN_BYTES));
        assert!(reader_wanted(events::Mode::V3, true, PROGRESS_MIN_BYTES));
        assert!(!reader_wanted(events::Mode::V3, false, PROGRESS_MIN_BYTES));
        assert!(!reader_wanted(
            events::Mode::V4,
            false,
            PROGRESS_MIN_BYTES - 1
        ));
    }

    /// The bar stays silent on v4, so the percentage must reach the consumer as an event (#1164).
    #[test]
    fn a_lone_download_reports_its_percentage_as_an_event_on_protocol_4() {
        let payload = vec![7u8; 1024];
        let mut reader = ProgressReader::new(payload.as_slice(), 1024, "models/encoder.onnx");
        reader.read = 512;
        let event = reader
            .progress_event(events::Mode::V4, 1)
            .expect("a lone v4 download reports");
        let json: serde_json::Value =
            serde_json::from_str(&event.render(events::Mode::V4)).expect("NDJSON");
        assert_eq!(json["kind"], "progress");
        assert_eq!(json["pct"], 50);
        assert!(
            json["message"]
                .as_str()
                .unwrap()
                .contains("models/encoder.onnx"),
            "the consumer cannot tell downloads apart without the name: {json}"
        );
    }

    #[test]
    fn no_event_on_protocol_3_or_beside_another_download() {
        let payload = vec![7u8; 1024];
        let mut reader = ProgressReader::new(payload.as_slice(), 1024, "models/encoder.onnx");
        reader.read = 512;
        assert!(
            reader.progress_event(events::Mode::V3, 1).is_none(),
            "the bar owns the row on protocol 3"
        );
        assert!(
            reader.progress_event(events::Mode::V4, 2).is_none(),
            "concurrent streams share one message channel the consumer cannot demultiplex"
        );
    }

    #[test]
    fn progress_reader_is_byte_transparent() {
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let mut out = Vec::new();
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64, "blob");
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
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64, "blob");
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
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64, "blob");
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
            let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64, "blob");
            reader.draw();
            assert!(*lock_stderr(), "bar row is open");
        }
        assert!(!*lock_stderr(), "drop must close the row");
    }
}
