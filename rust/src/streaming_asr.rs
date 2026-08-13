//! Live microphone transcription through FluidAudio's streaming ASR session.
//!
//! CoreML + macOS only; the ONNX backend has no streaming window and keeps the
//! record-then-transcribe path.

use std::os::fd::OwnedFd;

use anyhow::{Context, Result};
use audioadapter_buffers::direct::SequentialSliceOfVecs;
use fluidaudio_rs::FluidAudio;
use rubato::{Async, Resampler};

use crate::audio::{sinc_resampler, RESAMPLER_CHUNK_SIZE, TARGET_SAMPLE_RATE};
use crate::fluid_stdout::with_silenced_stdout;

/// A single streaming ASR session: `start` once, `feed` as samples arrive,
/// `finish` to get the transcript.
///
/// `start` re-runs `init_streaming_asr` and `finish` consumes `self` on purpose.
/// Upstream's `SlidingWindowAsrManager` does not reset in `startStreaming`, so a
/// second session on one manager returns the *first* session's transcript for
/// any input at all — including silence and an empty session. Re-initialising
/// builds a fresh manager (~97 ms once models are resident) and is the only
/// reset upstream offers at fluidaudio-rs 0.14.8 / 0.15.5. Making the session
/// non-reusable is what keeps that failure unreachable from here: it returns
/// plausible text rather than an error, so nothing downstream would catch it.
pub struct StreamingAsrSession {
    audio: FluidAudio,
    devnull: Option<OwnedFd>,
    resampler: StreamResampler,
}

impl StreamingAsrSession {
    /// `input_rate` is the microphone's native rate; samples are resampled to
    /// 16 kHz, which is what the FluidAudio bridge assumes when it wraps them.
    pub fn start(input_rate: u32) -> Result<Self> {
        let resampler = StreamResampler::new(input_rate, TARGET_SAMPLE_RATE)?;
        let devnull = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .ok()
            .map(OwnedFd::from);

        let audio = crate::models::fluidaudio_bridge(&crate::models::fluidaudio_asr_location()?)
            .context("failed to initialize FluidAudio bridge")?;
        with_silenced_stdout(devnull.as_ref(), || audio.init_streaming_asr()).context(
            "failed to initialize FluidAudio streaming ASR \
             (first run compiles models for ANE)",
        )?;
        with_silenced_stdout(devnull.as_ref(), || audio.streaming_asr_start())
            .context("failed to start FluidAudio streaming ASR session")?;

        Ok(Self {
            audio,
            devnull,
            resampler,
        })
    }

    pub fn feed(&mut self, mono: &[f32]) -> Result<()> {
        let ready = self.resampler.push(mono)?;
        if ready.is_empty() {
            return Ok(());
        }
        with_silenced_stdout(self.devnull.as_ref(), || {
            self.audio.streaming_asr_feed(&ready)
        })
        .context("failed to feed audio to FluidAudio streaming ASR")
    }

    pub fn finish(mut self) -> Result<String> {
        let tail = self.resampler.drain()?;
        if !tail.is_empty() {
            with_silenced_stdout(self.devnull.as_ref(), || {
                self.audio.streaming_asr_feed(&tail)
            })
            .context("failed to feed trailing audio to FluidAudio streaming ASR")?;
        }
        with_silenced_stdout(self.devnull.as_ref(), || self.audio.streaming_asr_finish())
            .context("FluidAudio streaming transcription failed")
    }
}

/// A resampler that outlives a single call, so a live session's chunk boundaries
/// don't each get a flushed-and-restarted filter the way repeated
/// [`crate::audio::resample_mono`] calls would.
struct StreamResampler {
    inner: Option<Async<f32>>,
    pending: Vec<f32>,
    ratio: f64,
}

impl StreamResampler {
    fn new(src_rate: u32, dst_rate: u32) -> Result<Self> {
        if src_rate == 0 {
            anyhow::bail!("microphone reported a sample rate of 0 Hz");
        }
        let ratio = dst_rate as f64 / src_rate as f64;
        let inner = if src_rate == dst_rate {
            None
        } else {
            Some(sinc_resampler(ratio, RESAMPLER_CHUNK_SIZE)?)
        };
        Ok(Self {
            inner,
            pending: Vec::new(),
            ratio,
        })
    }

    /// Converts as many whole blocks as `samples` completes, carrying the
    /// remainder into the next call so no input is dropped at a boundary.
    fn push(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        let Some(resampler) = self.inner.as_mut() else {
            return Ok(samples.to_vec());
        };

        self.pending.extend_from_slice(samples);
        let mut out = Vec::new();
        let mut consumed = 0usize;
        loop {
            let needed = resampler.input_frames_next();
            if self.pending.len() - consumed < needed {
                break;
            }
            let block = vec![self.pending[consumed..consumed + needed].to_vec()];
            out.extend_from_slice(&process_block(resampler, &block, needed)?);
            consumed += needed;
        }
        self.pending.drain(..consumed);
        Ok(out)
    }

    /// Zero-pads the leftover partial block and keeps only the output that
    /// corresponds to real input, matching `resample_mono`'s tail handling.
    fn drain(&mut self) -> Result<Vec<f32>> {
        let Some(resampler) = self.inner.as_mut() else {
            return Ok(std::mem::take(&mut self.pending));
        };
        if self.pending.is_empty() {
            return Ok(Vec::new());
        }

        let remaining = self.pending.len();
        let needed = resampler.input_frames_next();
        let mut last = std::mem::take(&mut self.pending);
        last.resize(needed, 0.0);
        let block = vec![last];
        let produced = process_block(resampler, &block, needed)?;
        let real = ((remaining as f64 * self.ratio) as usize).min(produced.len());
        Ok(produced[..real].to_vec())
    }
}

fn process_block(
    resampler: &mut Async<f32>,
    block: &[Vec<f32>],
    frames: usize,
) -> Result<Vec<f32>> {
    let input = SequentialSliceOfVecs::new(block, 1, frames)
        .context("failed to create resampler input adapter")?;
    let out_max = resampler.output_frames_max();
    let mut out_data: Vec<Vec<f32>> = vec![vec![0.0f32; out_max]; 1];
    let mut output = SequentialSliceOfVecs::new_mut(&mut out_data, 1, out_max)
        .context("failed to create resampler output adapter")?;
    let (_frames_in, frames_out) = resampler
        .process_into_buffer(&input, &mut output, None)
        .context("resampling microphone audio failed")?;
    out_data[0].truncate(frames_out);
    Ok(out_data.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_when_already_at_target_rate() {
        let mut r = StreamResampler::new(16_000, 16_000).unwrap();
        let out = r.push(&[0.1, 0.2, 0.3]).unwrap();
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
        assert!(r.drain().unwrap().is_empty());
    }

    #[test]
    fn rejects_a_zero_hz_device() {
        let err = match StreamResampler::new(0, 16_000) {
            Err(e) => e,
            Ok(_) => panic!("a 0 Hz device must be rejected"),
        };
        assert!(err.to_string().contains("0 Hz"), "unexpected error: {err}");
    }

    #[test]
    fn buffers_until_a_whole_block_is_available() {
        let mut r = StreamResampler::new(48_000, 16_000).unwrap();
        assert!(
            r.push(&vec![0.0f32; 100]).unwrap().is_empty(),
            "a sub-block feed must not produce output yet"
        );
        assert!(!r.push(&vec![0.0f32; 4_000]).unwrap().is_empty());
    }

    /// The live path feeds in mic-callback-sized pieces; the total output must
    /// still track the 48k→16k ratio, or samples are being dropped at the seams.
    #[test]
    fn chunked_feeding_conserves_length_across_blocks() {
        let mut r = StreamResampler::new(48_000, 16_000).unwrap();
        let one_second = vec![0.0f32; 48_000];
        let mut total = 0usize;
        for chunk in one_second.chunks(480) {
            total += r.push(chunk).unwrap().len();
        }
        total += r.drain().unwrap().len();
        let expected = 16_000f64;
        assert!(
            (total as f64 - expected).abs() / expected < 0.02,
            "expected ~{expected} samples out, got {total}"
        );
    }

    #[test]
    fn upsamples_from_a_slower_device() {
        let mut r = StreamResampler::new(8_000, 16_000).unwrap();
        let mut total = 0usize;
        for chunk in vec![0.0f32; 8_000].chunks(400) {
            total += r.push(chunk).unwrap().len();
        }
        total += r.drain().unwrap().len();
        assert!(
            (total as f64 - 16_000.0).abs() / 16_000.0 < 0.02,
            "expected ~16000 samples out, got {total}"
        );
    }

    fn fixture_samples(name: &str) -> Vec<f32> {
        let path = format!("{}/../tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        let bytes = std::fs::read(&path).expect("read fixture");
        assert!(
            !bytes.starts_with(b"version https://git-lfs"),
            "fixture is an unmaterialized Git LFS pointer — run `git lfs pull` first"
        );
        crate::audio::load_audio(&path).expect("decode fixture")
    }

    fn transcribe_streaming(samples: &[f32]) -> String {
        let mut session = StreamingAsrSession::start(TARGET_SAMPLE_RATE).expect("start session");
        for chunk in samples.chunks(1_600) {
            session.feed(chunk).expect("feed chunk");
        }
        session.finish().expect("finish session")
    }

    #[test]
    #[ignore = "needs cached CoreML Parakeet models + Apple Neural Engine; run with --run-ignored on macOS arm64"]
    fn streaming_session_transcribes_a_chunked_fixture() {
        let samples = fixture_samples("benchmark-en/03-review-pull-request.ogg");
        let text = transcribe_streaming(&samples);
        assert!(
            text.to_lowercase().contains("pull request"),
            "streaming session did not transcribe the fixture: {text:?}"
        );
    }

    /// Regression for the upstream defect documented at [`StreamingAsrSession`]:
    /// a second session must transcribe what *it* was fed, not repeat the first.
    #[test]
    #[ignore = "needs cached CoreML Parakeet models + Apple Neural Engine; run with --run-ignored on macOS arm64"]
    fn each_session_transcribes_its_own_audio() {
        let first =
            transcribe_streaming(&fixture_samples("benchmark-en/03-review-pull-request.ogg"));
        let second =
            transcribe_streaming(&fixture_samples("benchmark-en/05-database-migration.ogg"));
        assert!(
            first.to_lowercase().contains("pull request"),
            "first session did not transcribe its own fixture: {first:?}"
        );
        assert!(
            second.to_lowercase().contains("migration")
                && !second.to_lowercase().contains("pull request"),
            "second session repeated the first session's transcript \
             (first={first:?}, second={second:?})"
        );
    }

    #[test]
    #[ignore = "needs cached CoreML Parakeet models + Apple Neural Engine; run with --run-ignored on macOS arm64"]
    fn a_silent_session_transcribes_to_nothing() {
        let text = transcribe_streaming(&vec![0.0f32; TARGET_SAMPLE_RATE as usize * 3]);
        assert!(text.trim().is_empty(), "silence produced text: {text:?}");
    }
}
