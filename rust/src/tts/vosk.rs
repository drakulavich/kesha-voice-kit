//! Thin wrapper around `vosk_tts::{Model, Synth}` for Russian synthesis.
//!
//! Vosk-TTS handles text normalization, BERT-prosody, and G2P internally;
//! callers pass plain Russian text and a numeric speaker_id (0..=4 for the
//! 5 voices in vosk-model-tts-ru-0.9-multi).
//!
//! API note: `vosk-tts-rs 0.1.0` returns `Vec<i16>` PCM at the model's
//! sample rate. We convert to `f32` so it fits the rest of the TTS
//! pipeline (`wav::encode_wav` consumes f32 mono).

use anyhow::{Context, Result};
use std::path::Path;
use vosk_tts::{Model, Synth};

pub const SPEAKER_COUNT: u32 = 5;

pub struct Vosk {
    model: Model,
    synth: Synth,
    sample_rate: u32,
}

impl Vosk {
    /// Load the model bundle from `model_dir`. Expects the directory layout
    /// produced by `vosk_ru_manifest()` (model.onnx, dictionary, config.json,
    /// bert/model.onnx, bert/vocab.txt).
    pub fn load(model_dir: &Path) -> Result<Self> {
        let dir_str = model_dir
            .to_str()
            .with_context(|| format!("vosk model path is not utf-8: {}", model_dir.display()))?;
        let model = Model::new(Some(dir_str), None, None)
            .map_err(|e| anyhow::anyhow!("loading vosk model from {}: {e}", dir_str))?;
        let sample_rate = model.config.audio.sample_rate;
        Ok(Self {
            model,
            synth: Synth::new(),
            sample_rate,
        })
    }

    /// Sample rate reported by the loaded model config.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Synthesize `text` with the given speaker id (0..SPEAKER_COUNT).
    /// `rate` maps to vosk's `speech_rate` (1.0 = model default).
    pub fn infer(&mut self, text: &str, speaker_id: u32, rate: f32) -> Result<Vec<f32>> {
        if speaker_id >= SPEAKER_COUNT {
            anyhow::bail!(
                "vosk speaker_id must be 0..{} (got {speaker_id})",
                SPEAKER_COUNT
            );
        }
        let pcm = self
            .synth
            .synth_audio(
                &mut self.model,
                text,
                Some(speaker_id as i64),
                None,
                Some(rate),
                None,
                None,
            )
            .map_err(|e| {
                anyhow::anyhow!("vosk synth_audio failed for speaker {speaker_id}: {e}")
            })?;
        Ok(pcm.into_iter().map(|s| s as f32 / 32768.0).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_out_of_range_speaker() {
        let dir = crate::models::vosk_ru_model_dir();
        if !crate::models::is_vosk_ru_cached(&dir) {
            eprintln!(
                "vosk model not cached at {} — skipping speaker_id range test",
                dir.display()
            );
            return;
        }
        let mut v = Vosk::load(&dir).expect("load vosk");
        let err = v.infer("привет", SPEAKER_COUNT, 1.0).unwrap_err();
        assert!(err.to_string().contains("speaker_id"), "msg: {err}");
    }

    /// End-to-end synth (gated on cached model). Verifies a real ru phrase
    /// produces non-trivial PCM and uses the model-reported sample rate.
    #[test]
    fn synth_short_phrase_produces_audio() {
        let dir = crate::models::vosk_ru_model_dir();
        if !crate::models::is_vosk_ru_cached(&dir) {
            eprintln!(
                "vosk model not cached at {} — skipping synth e2e test",
                dir.display()
            );
            return;
        }
        let mut v = Vosk::load(&dir).expect("load vosk");
        assert_eq!(v.sample_rate(), 22050, "vosk-ru-0.9-multi is 22.05 kHz");
        let pcm = v.infer("Привет, мир.", 4, 1.0).expect("synth");
        // ~0.5s at 22.05kHz = 11025 samples lower bound; allow loose floor.
        assert!(pcm.len() > 5000, "got only {} samples", pcm.len());
        // f32 PCM should be in [-1, 1].
        for &s in pcm.iter().take(10000) {
            assert!((-1.5..=1.5).contains(&s), "sample out of range: {s}");
        }
    }
}
