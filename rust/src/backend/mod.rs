use anyhow::Result;

#[cfg(feature = "coreml")]
pub mod fluidaudio;
#[cfg(all(feature = "onnx", not(feature = "coreml")))]
pub mod onnx;

pub trait TranscribeBackend {
    fn transcribe(&mut self, audio_path: &str) -> Result<String>;
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
