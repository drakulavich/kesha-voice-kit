use std::os::fd::OwnedFd;

use anyhow::{Context, Result};
use fluidaudio_rs::FluidAudio;

use crate::fluid_stdout::with_silenced_stdout;

use super::TranscribeBackend;

/// FluidAudio's CoreML ASR rejects clips shorter than ~1s (returns
/// `invalidAudioData` and prints the error to stdout — see #259).
/// VAD spans frequently produce sub-second segments at speech onsets /
/// offsets, so we pad them with trailing silence before handing to
/// `transcribe_file`. 1.5 s @ 16 kHz = 24 000 samples; well above the
/// observed failure threshold and small enough that the extra silence
/// doesn't cost meaningful ASR latency.
const MIN_SAMPLES: usize = 16_000 + 16_000 / 2; // 1.5 s @ 16 kHz

pub struct FluidAudioBackend {
    audio: FluidAudio,
    /// Pre-opened /dev/null reused across `transcribe_samples` calls so
    /// the per-segment hot path skips the open syscall (~10K saved on a
    /// 1 h meeting). `None` when the open at construction time failed,
    /// in which case `with_silenced_stdout` falls back to running the
    /// closure with stdout untouched — never worse than the pre-#259
    /// behaviour, just with the residual print risk back on the table.
    devnull: Option<OwnedFd>,
}

impl FluidAudioBackend {
    pub fn new() -> Result<Self> {
        let audio = FluidAudio::new().context("failed to initialize FluidAudio bridge")?;
        audio
            .init_asr()
            .context("failed to initialize FluidAudio ASR (first run compiles models for ANE)")?;
        let devnull = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .ok()
            .map(OwnedFd::from);
        Ok(Self { audio, devnull })
    }
}

impl TranscribeBackend for FluidAudioBackend {
    fn transcribe(&mut self, audio_path: &str) -> Result<String> {
        let result = self
            .audio
            .transcribe_file(audio_path)
            .context("FluidAudio transcription failed")?;
        Ok(result.text)
    }

    /// Transcribe a raw 16 kHz mono f32 slice via FluidAudio's native
    /// `transcribe_samples` (published since `fluidaudio-rs` 0.14 — this
    /// replaced an earlier temp-WAV + `transcribe_file` shim).
    ///
    /// Sub-second VAD segments are padded to MIN_SAMPLES with trailing
    /// silence (#259); FluidAudio otherwise emits `Transcribe error:
    /// invalidAudioData` to stdout and returns an Err. stdout is silenced
    /// for the duration of the call as belt-and-braces — even with padding,
    /// residual upstream prints would corrupt the engine's `--json` output
    /// by interleaving with our JSON write.
    fn transcribe_samples(&mut self, samples: &[f32]) -> Result<String> {
        let padded = pad_to_min(samples, MIN_SAMPLES);
        let result = with_silenced_stdout(self.devnull.as_ref(), || {
            self.audio.transcribe_samples(&padded)
        })
        .context("FluidAudio sample transcription failed")?;
        Ok(result.text)
    }
}

/// Pad `samples` to at least `min_len` with trailing zeros (silence).
/// Returns a borrowed `Cow` so already-long-enough inputs don't allocate.
fn pad_to_min(samples: &[f32], min_len: usize) -> std::borrow::Cow<'_, [f32]> {
    if samples.len() >= min_len {
        std::borrow::Cow::Borrowed(samples)
    } else {
        let mut padded = Vec::with_capacity(min_len);
        padded.extend_from_slice(samples);
        padded.resize(min_len, 0.0);
        std::borrow::Cow::Owned(padded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pad_to_min_borrows_when_already_long_enough() {
        let s = vec![0.5_f32; MIN_SAMPLES];
        let out = pad_to_min(&s, MIN_SAMPLES);
        assert!(matches!(out, std::borrow::Cow::Borrowed(_)));
        assert_eq!(out.len(), MIN_SAMPLES);
    }

    #[test]
    fn pad_to_min_pads_short_clip_with_trailing_silence() {
        let original = vec![0.5_f32; 6_400]; // 0.4 s @ 16 kHz — the failing case from #259
        let out = pad_to_min(&original, MIN_SAMPLES);
        assert_eq!(out.len(), MIN_SAMPLES);
        // Original samples preserved at the head, silence at the tail.
        assert_eq!(&out[..6_400], original.as_slice());
        assert!(out[6_400..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn pad_to_min_handles_empty_input() {
        let out = pad_to_min(&[], MIN_SAMPLES);
        assert_eq!(out.len(), MIN_SAMPLES);
        assert!(out.iter().all(|&v| v == 0.0));
    }
}
