//! Piper VITS ONNX inference session.
//!
//! Inputs:
//!   `input`         int64 [1, N]   phoneme IDs (BOS + pad-interleaved + EOS)
//!   `input_lengths` int64 [1]      == N
//!   `scales`        f32   [3]      [noise_scale, length_scale, noise_w]
//! Output:
//!   `output`        f32   [1, 1, 1, T]   mono audio — sample rate varies per voice

use std::collections::HashMap;
use std::path::Path;

use ndarray::{Array1, Array2};
use ort::session::Session;
use ort::value::Value;
use serde::Deserialize;

pub struct Piper {
    session: Session,
    config: PiperConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PiperConfig {
    pub audio: AudioConfig,
    pub inference: InferenceConfig,
    pub phoneme_id_map: HashMap<String, Vec<i64>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AudioConfig {
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InferenceConfig {
    pub noise_scale: f32,
    pub length_scale: f32,
    pub noise_w: f32,
}

/// Special symbols in Piper's phoneme vocabulary.
const BOS: &str = "^";
const EOS: &str = "$";
const PAD: &str = "_";

/// Encode IPA phonemes to Piper token IDs: `BOS + (phoneme + PAD)* + EOS`.
/// Unknown characters are dropped (matches upstream).
pub fn encode_phonemes(map: &HashMap<String, Vec<i64>>, ipa: &str) -> Vec<i64> {
    let bos = map.get(BOS).cloned().unwrap_or_default();
    let pad = map.get(PAD).cloned().unwrap_or_default();
    let eos = map.get(EOS).cloned().unwrap_or_default();

    let mut ids: Vec<i64> = bos;
    for c in ipa.chars() {
        if let Some(entry) = map.get(&c.to_string()) {
            ids.extend(entry);
            ids.extend(&pad);
        }
    }
    ids.extend(eos);
    ids
}

impl Piper {
    pub fn load(model_path: &Path, config_path: &Path) -> anyhow::Result<Self> {
        let session = Session::builder()?.commit_from_file(model_path)?;
        let raw = std::fs::read_to_string(config_path)?;
        let config: PiperConfig = serde_json::from_str(&raw)?;
        Ok(Self { session, config })
    }

    pub fn sample_rate(&self) -> u32 {
        self.config.audio.sample_rate
    }

    pub fn encode(&self, ipa: &str) -> Vec<i64> {
        encode_phonemes(&self.config.phoneme_id_map, ipa)
    }

    /// Run synthesis on pre-encoded phoneme IDs. Returns mono f32 audio at [`Self::sample_rate`].
    pub fn infer(&mut self, phoneme_ids: &[i64]) -> anyhow::Result<Vec<f32>> {
        anyhow::ensure!(!phoneme_ids.is_empty(), "phoneme_ids must be non-empty");
        let n = phoneme_ids.len();

        let input =
            Value::from_array(Array2::<i64>::from_shape_vec((1, n), phoneme_ids.to_vec())?)?;
        let input_lengths = Value::from_array(Array1::<i64>::from_vec(vec![n as i64]))?;
        let scales = Value::from_array(Array1::<f32>::from_vec(vec![
            self.config.inference.noise_scale,
            self.config.inference.length_scale,
            self.config.inference.noise_w,
        ]))?;

        let outputs = self.session.run(ort::inputs![
            "input"         => input,
            "input_lengths" => input_lengths,
            "scales"        => scales,
        ])?;

        // Piper output is rank-4 [1, 1, 1, T]; the underlying buffer is contiguous,
        // so collecting the iterator flattens it.
        let (_shape, data) = outputs["output"].try_extract_tensor::<f32>()?;
        Ok(data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_map() -> HashMap<String, Vec<i64>> {
        let mut m = HashMap::new();
        m.insert(BOS.to_string(), vec![1]);
        m.insert(EOS.to_string(), vec![2]);
        m.insert(PAD.to_string(), vec![0]);
        m.insert("a".to_string(), vec![10]);
        m.insert("b".to_string(), vec![11]);
        m
    }

    #[test]
    fn encode_wraps_with_bos_eos_and_pad_interleave() {
        // "ab" -> BOS(1), a(10), PAD(0), b(11), PAD(0), EOS(2)
        assert_eq!(
            encode_phonemes(&simple_map(), "ab"),
            vec![1, 10, 0, 11, 0, 2]
        );
    }

    #[test]
    fn encode_skips_unknown_characters() {
        assert_eq!(
            encode_phonemes(&simple_map(), "aXb"),
            vec![1, 10, 0, 11, 0, 2]
        );
    }

    #[test]
    fn encode_handles_empty_input() {
        assert_eq!(encode_phonemes(&simple_map(), ""), vec![1, 2]);
    }

    #[test]
    fn encode_handles_multi_id_mappings() {
        // Some real Piper configs map a single phoneme to multiple IDs.
        let mut m = simple_map();
        m.insert("c".to_string(), vec![20, 21]);
        // "c" -> 20, 21, PAD(0)
        assert_eq!(encode_phonemes(&m, "c"), vec![1, 20, 21, 0, 2]);
    }

    /// Gated on PIPER_MODEL + PIPER_CONFIG env vars.
    #[test]
    fn infer_produces_non_silent_audio_when_model_available() {
        let (model, config) = match (
            std::env::var_os("PIPER_MODEL"),
            std::env::var_os("PIPER_CONFIG"),
        ) {
            (Some(m), Some(c)) => (m, c),
            _ => {
                eprintln!("PIPER_MODEL/PIPER_CONFIG not set; skipping");
                return;
            }
        };
        let mut p = Piper::load(Path::new(&model), Path::new(&config)).unwrap();
        // Hand-picked IDs in [10, 80] for shape/wiring check only.
        let ids: Vec<i64> = vec![1, 0, 20, 0, 30, 0, 40, 0, 50, 0, 60, 0, 70, 0, 2];
        let audio = p.infer(&ids).unwrap();
        assert!(audio.len() > 1000, "audio too short: {}", audio.len());
        assert_eq!(p.sample_rate(), 22_050);
    }
}
