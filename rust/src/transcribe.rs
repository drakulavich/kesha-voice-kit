use anyhow::Result;
use std::time::Instant;

use crate::backend;
use crate::dtrace;
use crate::models;

pub fn transcribe(audio_path: &str) -> Result<String> {
    let model_dir = models::asr_model_dir();
    dtrace!("asr::model_dir {}", model_dir);
    if !models::is_asr_cached(&model_dir) {
        anyhow::bail!(
            "Error: No transcription models installed\n\n\
             Please run: kesha install"
        );
    }
    let t0 = Instant::now();
    let mut be = backend::create_backend(&model_dir)?;
    dtrace!("asr::backend_loaded dt={}ms", t0.elapsed().as_millis());
    let t1 = Instant::now();
    let out = be.transcribe(audio_path)?;
    dtrace!(
        "asr::transcribe.end dt={}ms chars={}",
        t1.elapsed().as_millis(),
        out.chars().count()
    );
    Ok(out)
}
