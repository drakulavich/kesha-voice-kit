use anyhow::{Context, Result};
use std::path::Path;
use std::time::Instant;

use crate::audio;
use crate::backend;
use crate::dtrace;
use crate::models;
use crate::vad::{VadConfig, VadDetector, SAMPLE_RATE as VAD_SAMPLE_RATE};

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

/// VAD-preprocessed transcription (#128): segment the audio with Silero
/// VAD, transcribe each speech span independently, stitch with spaces.
///
/// Short/all-silence inputs fall back to a single full-file transcription
/// so the caller gets a sensible result rather than an empty string —
/// VAD is preprocessing, not gatekeeping.
pub fn transcribe_with_vad(audio_path: &str, cfg: VadConfig) -> Result<String> {
    let model_dir = models::asr_model_dir();
    if !models::is_asr_cached(&model_dir) {
        anyhow::bail!(
            "Error: No transcription models installed\n\n\
             Please run: kesha install"
        );
    }
    let vad_dir = models::vad_model_dir();
    if !models::is_vad_cached(&vad_dir) {
        anyhow::bail!(
            "Error: VAD model not installed\n\n\
             Please run: kesha install --vad"
        );
    }

    let t_audio = Instant::now();
    let samples = audio::load_audio(audio_path)?;
    dtrace!(
        "vad::audio_loaded dt={}ms samples={}",
        t_audio.elapsed().as_millis(),
        samples.len()
    );

    let t_vad = Instant::now();
    let vad_path = Path::new(&vad_dir).join("silero_vad.onnx");
    let mut vad = VadDetector::load(&vad_path).context("load Silero VAD")?;
    let segments = vad.detect_segments(&samples, cfg)?;
    dtrace!(
        "vad::detect dt={}ms segments={}",
        t_vad.elapsed().as_millis(),
        segments.len()
    );

    let mut be = backend::create_backend(&model_dir)?;

    // No speech detected → fall back to full-file pass. Preprocessing
    // shouldn't silently drop inputs; let the ASR decide whether there's
    // anything to say.
    if segments.is_empty() {
        dtrace!("vad::no_segments fallback=full_file");
        return be.transcribe(audio_path);
    }

    let sr = VAD_SAMPLE_RATE as f32;
    let mut transcripts: Vec<String> = Vec::with_capacity(segments.len());
    for (start_s, end_s) in &segments {
        let start = (*start_s * sr) as usize;
        let end = ((*end_s * sr) as usize).min(samples.len());
        if start >= end {
            continue;
        }
        let slice = &samples[start..end];
        let t = Instant::now();
        match be.transcribe_samples(slice) {
            Ok(text) => {
                dtrace!(
                    "vad::segment dt={}ms range={:.2}-{:.2}s chars={}",
                    t.elapsed().as_millis(),
                    start_s,
                    end_s,
                    text.chars().count()
                );
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    transcripts.push(trimmed.to_string());
                }
            }
            Err(e) => {
                // A single too-short / failing segment shouldn't kill the
                // whole transcript — log and keep going.
                eprintln!(
                    "warning: VAD segment {:.2}-{:.2}s failed: {e}",
                    start_s, end_s
                );
            }
        }
    }

    Ok(transcripts.join(" "))
}
