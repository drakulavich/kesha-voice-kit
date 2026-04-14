use anyhow::Result;

#[cfg(feature = "onnx")]
pub mod onnx;

pub trait TranscribeBackend {
    fn transcribe(&mut self, audio_samples: &[f32]) -> Result<String>;
}

/// On ONNX platforms, needs model_dir. On CoreML, model_dir is ignored.
pub fn create_backend(model_dir: &str) -> Result<Box<dyn TranscribeBackend>> {
    #[cfg(feature = "onnx")]
    {
        Ok(Box::new(onnx::OnnxBackend::new(model_dir)?))
    }
    #[cfg(not(feature = "onnx"))]
    {
        let _ = model_dir;
        anyhow::bail!("No backend available — build with --features onnx or coreml")
    }
}
