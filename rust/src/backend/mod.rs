use anyhow::Result;

#[cfg(feature = "coreml")]
pub mod fluidaudio;
#[cfg(feature = "onnx")]
pub mod onnx;

pub trait TranscribeBackend {
    fn transcribe(&mut self, audio_samples: &[f32]) -> Result<String>;
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
        let _ = model_dir;
        anyhow::bail!("No backend available — build with --features onnx or coreml")
    }
}
