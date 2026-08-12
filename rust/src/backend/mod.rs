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

pub trait TranscribeBackend {
    fn transcribe(&mut self, audio_path: &str) -> Result<TranscriptionChunk>;
    /// Transcribe a pre-decoded 16 kHz mono f32 waveform without re-reading
    /// from disk. Used by the VAD-segmented path to feed per-segment slices.
    fn transcribe_samples(&mut self, samples: &[f32]) -> Result<TranscriptionChunk>;
}

pub fn create_backend(model_dir: &str) -> Result<Box<dyn TranscribeBackend>> {
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
