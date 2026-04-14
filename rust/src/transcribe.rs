use anyhow::Result;

use crate::audio;
use crate::backend;
use crate::models;

pub fn transcribe(audio_path: &str) -> Result<String> {
    let model_dir = models::asr_model_dir();
    if !models::is_asr_cached(&model_dir) {
        anyhow::bail!(
            "Error: No transcription models installed\n\n\
             Please run: kesha install"
        );
    }
    let mut be = backend::create_backend(&model_dir)?;
    let samples = audio::load_audio(audio_path)?;
    be.transcribe(&samples)
}
