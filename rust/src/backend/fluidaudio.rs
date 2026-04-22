use anyhow::{Context, Result};
use fluidaudio_rs::FluidAudio;

use super::TranscribeBackend;

pub struct FluidAudioBackend {
    audio: FluidAudio,
}

impl FluidAudioBackend {
    pub fn new() -> Result<Self> {
        let audio = FluidAudio::new().context("failed to initialize FluidAudio bridge")?;
        audio
            .init_asr()
            .context("failed to initialize FluidAudio ASR (first run compiles models for ANE)")?;
        Ok(Self { audio })
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

    fn transcribe_samples(&mut self, samples: &[f32]) -> Result<String> {
        let result = self
            .audio
            .transcribe_samples(samples)
            .context("FluidAudio sample transcription failed")?;
        Ok(result.text)
    }
}
