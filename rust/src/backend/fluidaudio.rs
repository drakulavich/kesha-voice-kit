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
    /// Pre-opened /dev/null reused across `transcribe_samples` calls to skip
    /// the open syscall on the per-segment hot path (~10K saved on a 1 h meeting).
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

    /// stdout is silenced for the call: even with padding, upstream prints
    /// would corrupt `--json` output (#259).
    fn transcribe_samples(&mut self, samples: &[f32]) -> Result<String> {
        let padded = pad_to_min(samples, MIN_SAMPLES);
        let result = with_silenced_stdout(self.devnull.as_ref(), || {
            self.audio.transcribe_samples(&padded)
        })
        .context("FluidAudio sample transcription failed")?;
        Ok(result.text)
    }
}

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
        assert_eq!(&out[..6_400], original.as_slice());
        assert!(out[6_400..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn pad_to_min_handles_empty_input() {
        let out = pad_to_min(&[], MIN_SAMPLES);
        assert_eq!(out.len(), MIN_SAMPLES);
        assert!(out.iter().all(|&v| v == 0.0));
    }

    // Regression: the VAD/chunked paths call `transcribe_samples` once per
    // segment on a single backend instance. Before fluidaudio-rs carried the
    // upstream TDT stateless-reset fix (FluidInference/fluidaudio-rs#15), the
    // shared TdtDecoderState leaked the previous utterance's terminal token, so
    // the 2nd+ one-shot call collapsed to a degenerate prefix (usually "."). A
    // one-shot call must be independent of prior calls.
    #[test]
    #[ignore = "needs cached CoreML Parakeet models + Apple Neural Engine; run with --run-ignored on macOS arm64"]
    fn transcribe_samples_is_stateless_across_calls() {
        let wav = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/benchmark-en/03-review-pull-request.ogg"
        );
        // The fixture is a Git LFS asset; on a checkout without LFS materialized
        // the path is a ~130-byte pointer, not audio. Fail with an actionable
        // message instead of a cryptic decode panic.
        let bytes = std::fs::read(wav).expect("read sentence fixture");
        assert!(
            !bytes.starts_with(b"version https://git-lfs"),
            "fixture is an unmaterialized Git LFS pointer — run `git lfs pull` before this test"
        );
        let samples = crate::audio::load_audio(wav).expect("decode sentence fixture");

        let mut be = FluidAudioBackend::new().expect("init FluidAudio CoreML backend");
        let first = be
            .transcribe_samples(&samples)
            .expect("first transcribe_samples");
        let second = be
            .transcribe_samples(&samples)
            .expect("second transcribe_samples");

        assert!(
            !first.trim().is_empty(),
            "sanity: first call should transcribe speech, got {first:?}"
        );
        assert_eq!(
            first, second,
            "second one-shot call diverged — decoder state leaked across calls (got {second:?})"
        );
        assert!(
            !second.trim().trim_matches('.').trim().is_empty(),
            "second call collapsed to a degenerate prefix: {second:?}"
        );
    }
}
