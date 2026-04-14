use anyhow::Result;
use fluidaudio_rs::FluidAudio;

use super::TranscribeBackend;

pub struct FluidAudioBackend {
    audio: FluidAudio,
}

impl FluidAudioBackend {
    pub fn new() -> Result<Self> {
        let audio = FluidAudio::new()?;
        audio.init_asr()?;
        Ok(Self { audio })
    }
}

impl TranscribeBackend for FluidAudioBackend {
    fn transcribe(&mut self, audio_samples: &[f32]) -> Result<String> {
        let result = self.audio.transcribe_samples(audio_samples)?;
        Ok(result.text)
    }
}
