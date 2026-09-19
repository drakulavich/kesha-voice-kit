use std::io;
use std::ops::Range;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::protocol::events;

const PROGRESS_MIN_BYTES: u64 = 16 * 1024 * 1024;
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

static DOWNLOADS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Counts concurrent `download_verified` network phases so the reporter can tell whether it owns the channel.
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

/// Reports download progress as events as bytes arrive (#680, #1164).
///
/// Reports only while it is the sole download in flight: `parallel_download` runs
/// 4 rayon workers over one stderr, and the consumer renders one line per event
/// and cannot tell four downloads apart (Greptile P1 on #681). That still
/// covers the case this exists for — the 2.4GB encoder outlives every sibling by
/// minutes, so the long silent stretch is exactly when it is alone.
pub(super) struct ProgressReader<R> {
    inner: R,
    total: u64,
    read: u64,
    label: &'static str,
    emitted_pct: Option<usize>,
    last_draw: std::time::Instant,
}

/// A 206 body is only the remainder, so the span the events describe is the whole file.
pub(super) fn whole_file_total(resume: u64, content_length: Option<u64>) -> u64 {
    content_length.map_or(0, |remainder| resume + remainder)
}

/// Below the floor a download finishes fast enough that per-chunk events are noise.
pub(super) fn reader_wanted(total: u64) -> bool {
    total >= PROGRESS_MIN_BYTES
}

impl<R: io::Read> ProgressReader<R> {
    /// `span` is the slice of the file this stream carries: a resumed attempt starts past the bytes already staged.
    pub(super) fn new(inner: R, span: Range<u64>, label: &'static str) -> Self {
        Self {
            inner,
            total: span.end,
            read: span.start,
            label,
            emitted_pct: None,
            last_draw: std::time::Instant::now(),
        }
    }

    fn pct(&self) -> usize {
        ((self.read.min(self.total) as f64 / self.total as f64) * 100.0) as usize
    }

    fn progress_event(&mut self, in_flight: usize) -> Option<events::Event<'static>> {
        if in_flight != 1 {
            return None;
        }
        let pct = self.pct();
        if self.emitted_pct == Some(pct) {
            return None;
        }
        self.emitted_pct = Some(pct);
        Some(events::Event::progress_pct(
            Some("download"),
            format!(
                "{} {:.1}/{:.1}MB",
                self.label,
                self.read as f64 / 1_048_576.0,
                self.total as f64 / 1_048_576.0
            ),
            pct as u8,
        ))
    }

    fn draw(&mut self) {
        if let Some(event) = self.progress_event(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst)) {
            event.emit();
        }
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

#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn a_resumed_total_spans_the_file_not_the_remainder() {
        assert_eq!(
            whole_file_total(2_390 * 1_048_576, Some(10 * 1_048_576)),
            2_400 * 1_048_576
        );
        assert_eq!(whole_file_total(0, Some(16 * 1_048_576)), 16 * 1_048_576);
        assert_eq!(
            whole_file_total(2_390 * 1_048_576, None),
            0,
            "an unknown length must not read as already complete"
        );
    }

    #[test]
    fn the_reader_is_wanted_from_the_byte_floor_up() {
        assert!(reader_wanted(PROGRESS_MIN_BYTES));
        assert!(!reader_wanted(PROGRESS_MIN_BYTES - 1));
    }

    #[test]
    fn a_lone_download_reports_its_percentage_as_an_event() {
        let payload = vec![7u8; 1024];
        let mut reader = ProgressReader::new(payload.as_slice(), 0..1024, "models/encoder.onnx");
        reader.read = 512;
        let event = reader.progress_event(1).expect("a lone download reports");
        let json: serde_json::Value = serde_json::from_str(&event.render()).expect("NDJSON");
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

    /// An event stream is a log, not a repaint surface: one line per distinct percentage.
    #[test]
    fn a_download_reports_each_percentage_once_and_the_final_one_lands() {
        let payload = vec![7u8; 1000];
        let mut reader = ProgressReader::new(payload.as_slice(), 0..1000, "blob");
        reader.read = 990;
        assert!(reader.progress_event(1).is_some());
        reader.read = 995;
        assert!(
            reader.progress_event(1).is_none(),
            "still 99%, so the same line again is noise"
        );
        reader.read = 1000;
        let event = reader
            .progress_event(1)
            .expect("the final percentage must land");
        let json: serde_json::Value = serde_json::from_str(&event.render()).expect("NDJSON");
        assert_eq!(json["pct"], 100);
    }

    /// A 206 body is only the remainder: progress must describe the file, or a download stalled at 99% never reports 100.
    #[test]
    fn a_resumed_download_reports_the_whole_file_not_the_remainder() {
        let total = PROGRESS_MIN_BYTES;
        let remainder = vec![7u8; 1_048_576];
        let resume = total - remainder.len() as u64;
        assert!(reader_wanted(total));
        let mut reader = ProgressReader::new(remainder.as_slice(), resume..total, "blob");
        let first = reader
            .progress_event(1)
            .expect("a resumed download reports where it picks up");
        let json: serde_json::Value = serde_json::from_str(&first.render()).expect("NDJSON");
        assert_eq!(json["pct"], 93);
        assert!(
            json["message"].as_str().unwrap().ends_with("15.0/16.0MB"),
            "megabytes must agree with the percentage: {json}"
        );
        let mut out = Vec::new();
        reader.read_to_end(&mut out).expect("read");
        assert_eq!(out, remainder);
        let last = reader
            .progress_event(1)
            .expect("the final percentage must land");
        let json: serde_json::Value = serde_json::from_str(&last.render()).expect("NDJSON");
        assert_eq!(json["pct"], 100);
        assert!(
            json["message"].as_str().unwrap().ends_with("16.0/16.0MB"),
            "{json}"
        );
    }

    /// 4 rayon workers share one event channel the consumer cannot demultiplex (#681 P1).
    #[test]
    fn no_event_beside_another_download() {
        let payload = vec![7u8; 1024];
        let mut reader = ProgressReader::new(payload.as_slice(), 0..1024, "models/encoder.onnx");
        reader.read = 512;
        assert!(reader.progress_event(2).is_none());
    }

    #[test]
    fn progress_reader_is_byte_transparent() {
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let mut out = Vec::new();
        let mut reader = ProgressReader::new(payload.as_slice(), 0..payload.len() as u64, "blob");
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
}
