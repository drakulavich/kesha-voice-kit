use std::path::Path;

use anyhow::{Context, Result};
use ndarray::{Array1, Array2};
use ort::session::Session;
use ort::value::Value;

use super::TranscribeBackend;

const DECODER_LAYERS: usize = 2;
const DECODER_HIDDEN: usize = 640;
const MAX_TOKENS_PER_STEP: usize = 10;
const DEFAULT_BEAM_WIDTH: usize = 4;

pub struct OnnxBackend {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
    blank_id: usize,
}

impl OnnxBackend {
    pub fn new(model_dir: &str) -> Result<Self> {
        let model_path = Path::new(model_dir);

        let preprocessor = Session::builder()
            .context("Failed to create preprocessor session builder")?
            .commit_from_file(model_path.join("nemo128.onnx"))
            .context("Failed to load nemo128.onnx — run `kesha-engine install` first")?;

        let encoder = Session::builder()
            .context("Failed to create encoder session builder")?
            .commit_from_file(model_path.join("encoder-model.onnx"))
            .context("Failed to load encoder-model.onnx — run `kesha-engine install` first")?;

        let decoder = Session::builder()
            .context("Failed to create decoder session builder")?
            .commit_from_file(model_path.join("decoder_joint-model.onnx"))
            .context(
                "Failed to load decoder_joint-model.onnx — run `kesha-engine install` first",
            )?;

        let vocab = load_vocab(model_path.join("vocab.txt"))
            .context("Failed to load vocab.txt — run `kesha-engine install` first")?;

        let blank_id = vocab.len() - 1;

        Ok(Self {
            preprocessor,
            encoder,
            decoder,
            vocab,
            blank_id,
        })
    }

    /// Run the preprocessor (nemo128.onnx) to get mel-spectrogram features.
    fn preprocess(&mut self, audio_samples: &[f32]) -> Result<(Vec<f32>, Vec<usize>)> {
        let num_samples = audio_samples.len();

        let waveforms = Array2::<f32>::from_shape_vec((1, num_samples), audio_samples.to_vec())
            .context("Failed to create waveforms tensor")?;
        let waveforms_lens = Array1::<i64>::from_vec(vec![num_samples as i64]);

        let waveforms_value =
            Value::from_array(waveforms).context("Failed to create waveforms Value")?;
        let waveforms_lens_value =
            Value::from_array(waveforms_lens).context("Failed to create waveforms_lens Value")?;

        let outputs = self
            .preprocessor
            .run(ort::inputs![
                "waveforms" => waveforms_value,
                "waveforms_lens" => waveforms_lens_value,
            ])
            .context("Preprocessor inference failed")?;

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
    fn encode(
        &mut self,
        features_data: &[f32],
        features_lens: &[usize],
    ) -> Result<(Vec<f32>, Vec<usize>, Vec<usize>)> {
        // Reconstruct features as [1, 128, T]
        let total = features_data.len();
        let t = total / 128;
        let audio_signal =
            ndarray::Array3::<f32>::from_shape_vec((1, 128, t), features_data.to_vec())
                .context("Failed to reshape features to [1, 128, T]")?;
        let length = Array1::<i64>::from_vec(features_lens.iter().map(|&x| x as i64).collect());

        let audio_signal_value =
            Value::from_array(audio_signal).context("Failed to create audio_signal Value")?;
        let length_value = Value::from_array(length).context("Failed to create length Value")?;

        let outputs = self
            .encoder
            .run(ort::inputs![
                "audio_signal" => audio_signal_value,
                "length" => length_value,
            ])
            .context("Encoder inference failed")?;

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

    /// Run the decoder joint model for one step.
    /// encoder_frame: [D] — single frame from encoder output
    /// target: last emitted token ID
    /// state1, state2: RNN hidden states [DECODER_LAYERS * DECODER_HIDDEN]
    /// Returns: (output logits, new_state1, new_state2)
    fn decode_step(
        &mut self,
        encoder_frame: &[f32],
        target: i32,
        state1: &[f32],
        state2: &[f32],
    ) -> Result<(Vec<f32>, Vec<f32>, Vec<f32>)> {
        let d = encoder_frame.len();

        // encoder_outputs: [1, D, 1]
        let enc_arr = ndarray::Array3::<f32>::from_shape_vec((1, d, 1), encoder_frame.to_vec())?;
        let enc_val = Value::from_array(enc_arr)?;

        // targets: [1, 1]
        let targets_arr = ndarray::Array2::<i32>::from_shape_vec((1, 1), vec![target])?;
        let targets_val = Value::from_array(targets_arr)?;

        // target_length: [1]
        let target_len_arr = Array1::<i32>::from_vec(vec![1]);
        let target_len_val = Value::from_array(target_len_arr)?;

        // input_states_1: [DECODER_LAYERS, 1, DECODER_HIDDEN]
        let state1_arr = ndarray::Array3::<f32>::from_shape_vec(
            (DECODER_LAYERS, 1, DECODER_HIDDEN),
            state1.to_vec(),
        )?;
        let state1_val = Value::from_array(state1_arr)?;

        // input_states_2: [DECODER_LAYERS, 1, DECODER_HIDDEN]
        let state2_arr = ndarray::Array3::<f32>::from_shape_vec(
            (DECODER_LAYERS, 1, DECODER_HIDDEN),
            state2.to_vec(),
        )?;
        let state2_val = Value::from_array(state2_arr)?;

        let outputs = self
            .decoder
            .run(ort::inputs![
                "encoder_outputs" => enc_val,
                "targets" => targets_val,
                "target_length" => target_len_val,
                "input_states_1" => state1_val,
                "input_states_2" => state2_val,
            ])
            .context("Decoder inference failed")?;

        // Decoder outputs may be in different order — find by trying types
        // Expected: outputs (f32), output_states_1 (f32), output_states_2 (f32)
        // But some models have different ordering or extra outputs
        let mut output_data: Option<Vec<f32>> = None;
        let mut new_s1: Option<Vec<f32>> = None;
        let mut new_s2: Option<Vec<f32>> = None;

        for (_name, out) in outputs.iter() {
            if let Ok((shape, data)) = out.try_extract_tensor::<f32>() {
                let shape_vec: Vec<usize> = shape.iter().map(|&x| x as usize).collect();
                let data_vec: Vec<f32> = data.to_vec();

                if shape_vec.len() == 2 && output_data.is_none() {
                    output_data = Some(data_vec);
                } else if shape_vec.len() == 3 && shape_vec[0] == DECODER_LAYERS {
                    if new_s1.is_none() {
                        new_s1 = Some(data_vec);
                    } else if new_s2.is_none() {
                        new_s2 = Some(data_vec);
                    }
                } else if output_data.is_none() {
                    output_data = Some(data_vec);
                }
            }
        }

        let output_data = output_data.context("No decoder output tensor found")?;
        let new_state1 = new_s1.context("No output_states_1 tensor found")?;
        let new_state2 = new_s2.context("No output_states_2 tensor found")?;

        Ok((
            output_data.to_vec(),
            new_state1.to_vec(),
            new_state2.to_vec(),
        ))
    }

    /// RNN-T TDT beam search decoder.
    /// encoder_data: raw encoder output [1, D, T'] stored as flat [D*T'] in row-major
    /// encoder_dim: D (feature dimension)
    /// encoder_length: T' (number of frames)
    fn beam_decode(
        &mut self,
        encoder_data: &[f32],
        encoder_dim: usize,
        encoder_length: usize,
    ) -> Result<Vec<usize>> {
        if encoder_length == 0 {
            return Ok(vec![]);
        }

        let state_size = DECODER_LAYERS * DECODER_HIDDEN;
        let vocab_size = self.vocab.len();

        struct Beam {
            tokens: Vec<usize>,
            score: f32,
            last_token: i32,
            state1: Vec<f32>,
            state2: Vec<f32>,
            t: usize,
        }

        let mut beams = vec![Beam {
            tokens: vec![],
            score: 0.0,
            last_token: self.blank_id as i32,
            state1: vec![0.0; state_size],
            state2: vec![0.0; state_size],
            t: 0,
        }];

        let max_steps = encoder_length * MAX_TOKENS_PER_STEP;

        for _step in 0..max_steps {
            let active: Vec<usize> = beams
                .iter()
                .enumerate()
                .filter(|(_, b)| b.t < encoder_length)
                .map(|(i, _)| i)
                .collect();

            if active.is_empty() {
                break;
            }

            let mut candidates: Vec<Beam> = Vec::new();

            for &beam_idx in &active {
                let beam = &beams[beam_idx];

                // Extract encoder frame at position beam.t
                // encoder_data layout: [1, D, T'] row-major → element [0, d, t] = d * T' + t
                let frame: Vec<f32> = (0..encoder_dim)
                    .map(|d| encoder_data[d * encoder_length + beam.t])
                    .collect();

                let (output, new_state1, new_state2) =
                    self.decode_step(&frame, beam.last_token, &beam.state1, &beam.state2)?;

                let token_logits = &output[..vocab_size];
                let duration_logits = &output[vocab_size..];

                // Duration: argmax of duration logits
                let duration = argmax(duration_logits);

                // Blank option: advance one frame, keep same tokens
                candidates.push(Beam {
                    tokens: beam.tokens.clone(),
                    score: beam.score + token_logits[self.blank_id],
                    last_token: beam.last_token,
                    state1: new_state1.clone(),
                    state2: new_state2.clone(),
                    t: beam.t + 1,
                });

                // Top-K non-blank token options
                let top_k = top_k_indices(token_logits, DEFAULT_BEAM_WIDTH, self.blank_id);
                for token_id in top_k {
                    candidates.push(Beam {
                        tokens: {
                            let mut t = beam.tokens.clone();
                            t.push(token_id);
                            t
                        },
                        score: beam.score + token_logits[token_id],
                        last_token: token_id as i32,
                        state1: new_state1.clone(),
                        state2: new_state2.clone(),
                        t: if duration > 0 {
                            beam.t + duration
                        } else {
                            beam.t
                        },
                    });
                }
            }

            candidates.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            beams = candidates.into_iter().take(DEFAULT_BEAM_WIDTH).collect();
        }

        Ok(beams
            .into_iter()
            .next()
            .map(|b| b.tokens)
            .unwrap_or_default())
    }

    /// Detokenize: map token IDs to strings, replace ▁ with space, trim.
    fn detokenize(&self, token_ids: &[usize]) -> String {
        let text: String = token_ids
            .iter()
            .filter_map(|&id| self.vocab.get(id))
            .map(|t| t.replace('\u{2581}', " "))
            .collect();
        text.trim().to_string()
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

        // logits_shape: [1, D, T']
        let encoder_dim = logits_shape[1];
        let encoder_length = encoded_lengths[0].min(logits_shape[2]);

        let token_ids = self.beam_decode(&logits_data, encoder_dim, encoder_length)?;
        let text = self.detokenize(&token_ids);

        Ok(text)
    }
}

fn argmax(arr: &[f32]) -> usize {
    let mut best = 0;
    let mut best_val = f32::NEG_INFINITY;
    for (i, &v) in arr.iter().enumerate() {
        if v > best_val {
            best_val = v;
            best = i;
        }
    }
    best
}

fn top_k_indices(arr: &[f32], k: usize, exclude: usize) -> Vec<usize> {
    let mut indexed: Vec<(f32, usize)> = arr
        .iter()
        .enumerate()
        .filter(|&(i, _)| i != exclude)
        .map(|(i, &v)| (v, i))
        .collect();
    indexed.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    indexed.iter().take(k).map(|&(_, i)| i).collect()
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
