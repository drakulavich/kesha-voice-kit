use std::path::Path;

use anyhow::{Context, Result};
use ndarray::{Array1, Array2};
use ort::session::Session;
use ort::value::Value;

use super::TranscribeBackend;

pub struct OnnxBackend {
    preprocessor: Session,
    encoder: Session,
    vocab: Vec<String>,
    blank_id: usize,
}

impl OnnxBackend {
    pub fn new(model_dir: &str) -> Result<Self> {
        let model_path = Path::new(model_dir);

        let preprocessor = Session::builder()
            .context("Failed to create preprocessor session builder")?
            .commit_from_file(model_path.join("nemo128.onnx"))
            .context("Failed to load nemo128.onnx — run `parakeet-engine install` first")?;

        let encoder = Session::builder()
            .context("Failed to create encoder session builder")?
            .commit_from_file(model_path.join("encoder-model.onnx"))
            .context("Failed to load encoder-model.onnx — run `parakeet-engine install` first")?;

        let vocab = load_vocab(model_path.join("vocab.txt"))
            .context("Failed to load vocab.txt — run `parakeet-engine install` first")?;

        // Blank token is the last entry in the vocab
        let blank_id = vocab.len() - 1;

        Ok(Self {
            preprocessor,
            encoder,
            vocab,
            blank_id,
        })
    }

    /// Run the preprocessor (nemo128.onnx) to get mel-spectrogram features.
    fn preprocess(&mut self, audio_samples: &[f32]) -> Result<(Vec<f32>, Vec<usize>)> {
        let num_samples = audio_samples.len();

        let waveforms =
            Array2::<f32>::from_shape_vec((1, num_samples), audio_samples.to_vec())
                .context("Failed to create waveforms tensor")?;
        let waveforms_lens =
            Array1::<i64>::from_vec(vec![num_samples as i64]);

        let waveforms_value = Value::from_array(waveforms)
            .context("Failed to create waveforms Value")?;
        let waveforms_lens_value = Value::from_array(waveforms_lens)
            .context("Failed to create waveforms_lens Value")?;

        let outputs = self.preprocessor.run(
            ort::inputs![
                "waveforms" => waveforms_value,
                "waveforms_lens" => waveforms_lens_value,
            ],
        ).context("Preprocessor inference failed")?;

        // Extract features [1, 128, T]
        let (features_shape, features_data) = outputs[0]
            .try_extract_tensor::<f32>()
            .context("Failed to extract features tensor")?;
        let features_shape: Vec<usize> = features_shape.iter().map(|&x| x as usize).collect();
        let features_data: Vec<f32> = features_data.to_vec();

        // Extract features_lens [1]
        let (_lens_shape, lens_data) = outputs[1]
            .try_extract_tensor::<i64>()
            .context("Failed to extract features_lens tensor")?;
        let lens: Vec<usize> = lens_data.iter().map(|&x| x as usize).collect();

        let _ = features_shape; // shape is [1, 128, T], we pass raw data
        Ok((features_data, lens))
    }

    /// Run the encoder (encoder-model.onnx) on mel features.
    fn encode(&mut self, features_data: &[f32], features_lens: &[usize]) -> Result<(Vec<f32>, Vec<usize>, Vec<usize>)> {
        // Reconstruct features as [1, 128, T]
        let total = features_data.len();
        let t = total / 128;
        let audio_signal =
            ndarray::Array3::<f32>::from_shape_vec((1, 128, t), features_data.to_vec())
                .context("Failed to reshape features to [1, 128, T]")?;
        let length =
            Array1::<i64>::from_vec(features_lens.iter().map(|&x| x as i64).collect());

        let audio_signal_value = Value::from_array(audio_signal)
            .context("Failed to create audio_signal Value")?;
        let length_value = Value::from_array(length)
            .context("Failed to create length Value")?;

        let outputs = self.encoder.run(
            ort::inputs![
                "audio_signal" => audio_signal_value,
                "length" => length_value,
            ],
        ).context("Encoder inference failed")?;

        // Output: logits [1, D, T'] and encoded_lengths [1]
        let (logits_shape_raw, logits_raw) = outputs[0]
            .try_extract_tensor::<f32>()
            .context("Failed to extract logits tensor")?;
        let logits_shape: Vec<usize> = logits_shape_raw.iter().map(|&x| x as usize).collect();
        let logits_data: Vec<f32> = logits_raw.to_vec();

        let (_enc_shape, enc_raw) = outputs[1]
            .try_extract_tensor::<i64>()
            .context("Failed to extract encoded_lengths tensor")?;
        let enc_lens: Vec<usize> = enc_raw.iter().map(|&x| x as usize).collect();

        Ok((logits_data, logits_shape, enc_lens))
    }

    /// Greedy CTC-style decoding on encoder logits.
    fn greedy_decode(
        &self,
        logits_data: &[f32],
        logits_shape: &[usize],
        encoded_lengths: &[usize],
    ) -> Result<String> {
        // logits_shape is [1, D, T']
        let d = logits_shape[1]; // vocab dimension
        let t_prime = logits_shape[2]; // time steps
        let actual_len = encoded_lengths[0].min(t_prime);

        let mut token_ids: Vec<usize> = Vec::new();
        let mut prev_id: Option<usize> = None;

        for t in 0..actual_len {
            // Find argmax over D dimension for frame t
            // logits layout: [1, D, T'] — so element [0, d, t] = d * t_prime + t
            let mut best_id = 0;
            let mut best_val = f32::NEG_INFINITY;
            for d_idx in 0..d {
                let val = logits_data[d_idx * t_prime + t];
                if val > best_val {
                    best_val = val;
                    best_id = d_idx;
                }
            }

            // Skip blank tokens
            if best_id == self.blank_id {
                prev_id = None;
                continue;
            }

            // Collapse consecutive duplicates
            if Some(best_id) == prev_id {
                continue;
            }

            token_ids.push(best_id);
            prev_id = Some(best_id);
        }

        // Map token IDs to strings
        let mut text = String::new();
        for id in &token_ids {
            if *id < self.vocab.len() {
                text.push_str(&self.vocab[*id]);
            }
        }

        // Replace ▁ (U+2581) with space and trim
        let text = text.replace('\u{2581}', " ");
        let text = text.trim().to_string();

        Ok(text)
    }
}

impl TranscribeBackend for OnnxBackend {
    fn transcribe(&mut self, audio_samples: &[f32]) -> Result<String> {
        if audio_samples.len() < 1600 {
            anyhow::bail!(
                "Audio too short: {} samples ({:.2}s) — minimum is 0.1s (1600 samples at 16kHz)",
                audio_samples.len(),
                audio_samples.len() as f64 / 16000.0
            );
        }

        let (features_data, features_lens) = self.preprocess(audio_samples)?;
        let (logits_data, logits_shape, encoded_lengths) =
            self.encode(&features_data, &features_lens)?;
        let text = self.greedy_decode(&logits_data, &logits_shape, &encoded_lengths)?;

        Ok(text)
    }
}

/// Load vocab.txt: each line has "token id" format, or just one token per line.
fn load_vocab<P: AsRef<Path>>(path: P) -> Result<Vec<String>> {
    let content = std::fs::read_to_string(path.as_ref())
        .with_context(|| format!("Cannot read vocab file: {}", path.as_ref().display()))?;

    let mut vocab: Vec<String> = Vec::new();

    for line in content.lines() {
        if line.is_empty() {
            continue;
        }
        // Try "token id" format first (matching TS tokenizer)
        if let Some(last_space) = line.rfind(' ') {
            let token = &line[..last_space];
            let id_str = &line[last_space + 1..];
            if let Ok(id) = id_str.parse::<usize>() {
                // Ensure vocab is large enough
                if id >= vocab.len() {
                    vocab.resize(id + 1, String::new());
                }
                vocab[id] = token.to_string();
                continue;
            }
        }
        // Fallback: one token per line, index = line number
        vocab.push(line.to_string());
    }

    if vocab.is_empty() {
        anyhow::bail!("Vocab file is empty: {}", path.as_ref().display());
    }

    Ok(vocab)
}
