use std::path::Path;

use anyhow::Result;

use crate::transcribe::WordTiming;

#[cfg(feature = "coreml")]
pub mod fluidaudio;
#[cfg(all(feature = "onnx", not(feature = "coreml")))]
pub mod onnx;

/// One backend pass over a waveform. `words` is `None` on backends that cannot
/// produce word timings — never `Some(vec![])` for "unsupported", so callers can
/// tell "this build can't" from "this audio had no speech" (#720).
///
/// Times are relative to the *slice* handed to the backend, not to the file; the
/// caller owns the offset.
#[derive(Debug)]
pub struct TranscriptionChunk {
    pub text: String,
    pub words: Option<Vec<WordTiming>>,
}

impl From<String> for TranscriptionChunk {
    fn from(text: String) -> Self {
        Self { text, words: None }
    }
}

/// Shorter than one featuriser frame can use, so the file is the problem rather
/// than the engine — both backends code it as input, not `E_INTERNAL` (#995).
pub const MIN_TRANSCRIBABLE_SAMPLES: usize = 1600;

pub fn ensure_transcribable(samples: &[f32]) -> Result<()> {
    if samples.len() < MIN_TRANSCRIBABLE_SAMPLES {
        crate::coded_bail!(
            crate::errors::ErrorCode::BadAudio,
            "audio too short: {} samples ({:.2}s) — minimum is {:.2}s at 16 kHz",
            samples.len(),
            samples.len() as f64 / 16_000.0,
            MIN_TRANSCRIBABLE_SAMPLES as f64 / 16_000.0
        )
    }
    Ok(())
}

pub trait TranscribeBackend {
    fn transcribe(&mut self, audio_path: &Path) -> Result<TranscriptionChunk>;
    /// Transcribe a pre-decoded 16 kHz mono f32 waveform without re-reading
    /// from disk. Used by the VAD-segmented path to feed per-segment slices.
    fn transcribe_samples(&mut self, samples: &[f32]) -> Result<TranscriptionChunk>;
}

pub fn create_backend(model_dir: &Path) -> Result<Box<dyn TranscribeBackend>> {
    #[cfg(feature = "coreml")]
    {
        let _ = model_dir;
        Ok(Box::new(fluidaudio::FluidAudioBackend::new()?))
    }
    #[cfg(all(feature = "onnx", not(feature = "coreml")))]
    {
        Ok(Box::new(onnx::OnnxBackend::new(model_dir)?))
    }
    #[cfg(not(any(feature = "onnx", feature = "coreml")))]
    {
        use crate::coded_bail;
        use crate::errors::ErrorCode;
        let _ = model_dir;
        coded_bail!(
            ErrorCode::NoBackend,
            "No backend available — build with --features onnx or coreml"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::{code_of, ErrorCode};

    #[test]
    fn a_clip_below_the_floor_is_the_user_s_input_not_an_engine_fault() {
        let err = ensure_transcribable(&vec![0.0; MIN_TRANSCRIBABLE_SAMPLES - 1])
            .expect_err("below the floor must fail");
        assert_eq!(code_of(&err), ErrorCode::BadAudio, "{err:#}");
        assert!(format!("{err:#}").contains("0.10s"), "{err:#}");
    }

    #[test]
    fn a_clip_at_the_floor_passes() {
        assert!(ensure_transcribable(&vec![0.0; MIN_TRANSCRIBABLE_SAMPLES]).is_ok());
    }

    struct StubBackend;

    impl TranscribeBackend for StubBackend {
        fn transcribe(&mut self, audio_path: &Path) -> Result<TranscriptionChunk> {
            Ok(audio_path.display().to_string().into())
        }

        fn transcribe_samples(&mut self, _samples: &[f32]) -> Result<TranscriptionChunk> {
            unimplemented!("not exercised by this test")
        }
    }

    // Guards a revert to `&str`; a generic `AsRef<Path>` signature would also satisfy this, and that's fine (#958).
    #[test]
    fn transcribe_takes_a_path_argument() {
        let mut be = StubBackend;
        let chunk = be
            .transcribe(Path::new("/tmp/958.wav"))
            .expect("stub never fails");
        assert_eq!(chunk.text, "/tmp/958.wav");
    }
}
