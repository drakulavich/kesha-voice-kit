use std::path::Path;

use anyhow::{Context, Result};
use ndarray::{Array1, Array2};
use ort::session::Session;
use ort::value::Value;

use crate::audio;
use crate::errors::{CodedContext, ErrorCode};
use crate::transcribe::WordTiming;
use crate::util::argmax;

use super::{TranscribeBackend, TranscriptionChunk};

const DECODER_LAYERS: usize = 2;
const DECODER_HIDDEN: usize = 640;
const MAX_TOKENS_PER_STEP: usize = 10;
const DEFAULT_BEAM_WIDTH: usize = 4;

/// Parakeet's encoder subsamples the 10 ms mel hop 8×, so one encoder frame —
/// the unit `Beam.t` counts in — is 80 ms. Matches the `secondsPerEncoderFrame`
/// FluidAudio derives word times from on the CoreML path (#720).
const SECONDS_PER_ENCODER_FRAME: f32 = 0.08;

pub struct OnnxBackend {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
    blank_id: usize,
}

impl OnnxBackend {
    pub fn new(model_path: &Path) -> Result<Self> {
        let preprocessor = Session::builder()
            .context("Failed to create preprocessor session builder")
            .coded(ErrorCode::ModelLoad)?
            .commit_from_file(model_path.join("nemo128.onnx"))
            .context("Failed to load nemo128.onnx — run `kesha-engine install` first")
            .coded(ErrorCode::ModelLoad)?;

        let encoder = Session::builder()
            .context("Failed to create encoder session builder")
            .coded(ErrorCode::ModelLoad)?
            .commit_from_file(model_path.join("encoder-model.onnx"))
            .context("Failed to load encoder-model.onnx — run `kesha-engine install` first")
            .coded(ErrorCode::ModelLoad)?;

        let decoder = Session::builder()
            .context("Failed to create decoder session builder")
            .coded(ErrorCode::ModelLoad)?
            .commit_from_file(model_path.join("decoder_joint-model.onnx"))
            .context("Failed to load decoder_joint-model.onnx — run `kesha-engine install` first")
            .coded(ErrorCode::ModelLoad)?;

        let vocab = load_vocab(model_path.join("vocab.txt"))
            .context("Failed to load vocab.txt — run `kesha-engine install` first")
            .coded(ErrorCode::ModelLoad)?;

        let blank_id = vocab.len() - 1;

        Ok(Self {
            preprocessor,
            encoder,
            decoder,
            vocab,
            blank_id,
        })
    }

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

        // features shape: [1, 128, T]
        let (features_shape, features_data) = outputs[0]
            .try_extract_tensor::<f32>()
            .context("Failed to extract features tensor")?;
        let features_shape: Vec<usize> = features_shape.iter().map(|&x| x as usize).collect();
        let features_data: Vec<f32> = features_data.to_vec();

        let (_lens_shape, lens_data) = outputs[1]
            .try_extract_tensor::<i64>()
            .context("Failed to extract features_lens tensor")?;
        let lens: Vec<usize> = lens_data.iter().map(|&x| x as usize).collect();

        let _ = features_shape; // shape is [1, 128, T], we pass raw data
        Ok((features_data, lens))
    }

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

        // Output order varies by model version; disambiguate by tensor rank.
        // Rank-2 → joint logits; rank-3 with dim-0 == DECODER_LAYERS → recurrent state.
        let (output_data, new_s1, new_s2) = classify_decoder_outputs(&outputs)?;

        Ok((output_data, new_s1, new_s2))
    }

    fn beam_decode(
        &mut self,
        encoder_data: &[f32],
        encoder_dim: usize,
        encoder_length: usize,
    ) -> Result<Vec<TokenTiming>> {
        let blank_id = self.blank_id;
        let vocab_size = self.vocab.len();
        beam_search(
            encoder_data,
            encoder_dim,
            encoder_length,
            blank_id,
            vocab_size,
            |frame, last_token, state1, state2| self.decode_step(frame, last_token, state1, state2),
        )
    }

    fn detokenize(&self, token_ids: &[usize]) -> String {
        detokenize(&self.vocab, token_ids)
    }
}

impl TranscribeBackend for OnnxBackend {
    fn transcribe(&mut self, audio_path: &Path) -> Result<TranscriptionChunk> {
        let audio_samples = audio::load_audio(&audio_path.to_string_lossy())?;
        self.transcribe_samples(&audio_samples)
    }

    fn transcribe_samples(&mut self, audio_samples: &[f32]) -> Result<TranscriptionChunk> {
        super::ensure_transcribable(audio_samples)?;

        let (features_data, features_lens) = self.preprocess(audio_samples)?;
        let (logits_data, logits_shape, encoded_lengths) =
            self.encode(&features_data, &features_lens)?;

        // logits_shape: [1, D, T']
        let encoder_dim = logits_shape[1];
        let encoder_length = encoded_lengths[0].min(logits_shape[2]);

        let timings = self.beam_decode(&logits_data, encoder_dim, encoder_length)?;
        let ids: Vec<usize> = timings.iter().map(|t| t.id).collect();
        let text = self.detokenize(&ids);
        let words = group_words(&self.vocab, &timings);

        Ok(TranscriptionChunk {
            text,
            words: Some(words),
        })
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (no Session access)
// ---------------------------------------------------------------------------

/// A decoded token with the encoder frames it was emitted over: `start_frame`
/// is the frame the decoder was on, `end_frame` adds the TDT duration head's
/// prediction. `end_frame == start_frame` when the model predicted duration 0
/// (another token on the same frame).
#[derive(Debug, Clone, PartialEq)]
struct TokenTiming {
    id: usize,
    start_frame: usize,
    end_frame: usize,
}

/// Group decoded tokens into words on the SentencePiece `▁` boundary.
///
/// Yields exactly one word per whitespace-separated word of
/// [`detokenize`]'s output over the same tokens, so callers can drop words in
/// step with a trimmed text prefix. Word `end` is floored one frame past
/// `start`, so a span is never empty even when the duration head predicts 0.
fn group_words(vocab: &[String], timings: &[TokenTiming]) -> Vec<WordTiming> {
    let mut out: Vec<WordTiming> = Vec::new();
    for t in timings {
        let Some(piece) = vocab.get(t.id) else {
            continue;
        };
        let start = t.start_frame as f32 * SECONDS_PER_ENCODER_FRAME;
        let end = t.end_frame.max(t.start_frame + 1) as f32 * SECONDS_PER_ENCODER_FRAME;
        for (i, part) in piece.replace('\u{2581}', " ").split(' ').enumerate() {
            if i > 0 || out.is_empty() {
                out.push(WordTiming {
                    word: String::new(),
                    start,
                    end,
                });
            } else if part.is_empty() {
                // A word-initial `▁token` splits as ["", "token"]: the empty
                // head belongs to no word and must not stretch the last one.
                continue;
            }
            let word = out.last_mut().expect("pushed above when empty");
            word.word.push_str(part);
            word.end = word.end.max(end);
        }
    }
    out.retain(|w| !w.word.is_empty());
    out
}

fn detokenize(vocab: &[String], token_ids: &[usize]) -> String {
    let text: String = token_ids
        .iter()
        .filter_map(|&id| vocab.get(id))
        .map(|t| t.replace('\u{2581}', " "))
        .collect();
    text.trim().to_string()
}

/// Extracts one encoder frame: encoder_data is row-major [1, D, T'], so
/// element [0, d, t] = d * T' + t.
fn extract_encoder_frame(
    encoder_data: &[f32],
    encoder_dim: usize,
    encoder_length: usize,
    t: usize,
) -> Vec<f32> {
    (0..encoder_dim)
        .map(|d| encoder_data[d * encoder_length + t])
        .collect()
}

/// Classifies raw decoder outputs by tensor rank/shape and returns
/// (joint_logits, state1, state2).  Output order varies by model version.
fn classify_decoder_outputs(
    outputs: &ort::session::SessionOutputs,
) -> Result<(Vec<f32>, Vec<f32>, Vec<f32>)> {
    let mut output_data: Option<Vec<f32>> = None;
    let mut new_s1: Option<Vec<f32>> = None;
    let mut new_s2: Option<Vec<f32>> = None;

    for (_name, out) in outputs.iter() {
        let Ok((shape, data)) = out.try_extract_tensor::<f32>() else {
            continue;
        };
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

    let output_data = output_data.context("No decoder output tensor found")?;
    let new_state1 = new_s1.context("No output_states_1 tensor found")?;
    let new_state2 = new_s2.context("No output_states_2 tensor found")?;
    Ok((output_data, new_state1, new_state2))
}

/// TDT beam search over pre-computed encoder frames. `step` runs one decoder
/// inference (`(frame, last_token, state1, state2)` → `(joint_output, new_state1,
/// new_state2)`); injecting it keeps the search testable without an ONNX
/// session, mirroring `transcribe::build_chunked_output_segments`.
fn beam_search<F>(
    encoder_data: &[f32],
    encoder_dim: usize,
    encoder_length: usize,
    blank_id: usize,
    vocab_size: usize,
    mut step: F,
) -> Result<Vec<TokenTiming>>
where
    F: FnMut(&[f32], i32, &[f32], &[f32]) -> Result<(Vec<f32>, Vec<f32>, Vec<f32>)>,
{
    if encoder_length == 0 {
        return Ok(vec![]);
    }

    let state_size = DECODER_LAYERS * DECODER_HIDDEN;

    struct Beam {
        tokens: Vec<TokenTiming>,
        score: f32,
        last_token: i32,
        state1: Vec<f32>,
        state2: Vec<f32>,
        t: usize,
    }

    let mut beams = vec![Beam {
        tokens: vec![],
        score: 0.0,
        last_token: blank_id as i32,
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
            let frame = extract_encoder_frame(encoder_data, encoder_dim, encoder_length, beam.t);
            let (output, new_state1, new_state2) =
                step(&frame, beam.last_token, &beam.state1, &beam.state2)?;

            if output.len() <= vocab_size {
                anyhow::bail!(
                    "joint output has {} logits, expected token logits ({}) plus TDT \
                     duration logits — wrong or truncated decoder checkpoint?",
                    output.len(),
                    vocab_size
                );
            }
            let token_logits = &output[..vocab_size];
            let duration_logits = &output[vocab_size..];
            let duration = argmax(duration_logits);

            // Blank: advance one frame, no new token
            candidates.push(Beam {
                tokens: beam.tokens.clone(),
                score: beam.score + token_logits[blank_id],
                last_token: beam.last_token,
                state1: new_state1.clone(),
                state2: new_state2.clone(),
                t: beam.t + 1,
            });

            // Top-K non-blank tokens
            for token_id in top_k_indices(token_logits, DEFAULT_BEAM_WIDTH, blank_id) {
                let mut tokens = beam.tokens.clone();
                // The token is emitted while decoding frame `beam.t`, and the TDT
                // duration head predicts how many frames it covers — the same two
                // numbers FluidAudio turns into word times on CoreML (#720).
                tokens.push(TokenTiming {
                    id: token_id,
                    start_frame: beam.t,
                    end_frame: beam.t + duration,
                });
                candidates.push(Beam {
                    tokens,
                    score: beam.score + token_logits[token_id],
                    last_token: token_id as i32,
                    state1: new_state1.clone(),
                    state2: new_state2.clone(),
                    // duration == 0 means stay on this frame (emit another token)
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

// ---------------------------------------------------------------------------
// Unit tests for pure helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab_of(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detokenize_sentencepiece_underscore() {
        // U+2581 marks a leading space in SentencePiece tokens
        let vocab = vocab_of(&["h", "e", "l", "l", "o", "\u{2581}w", "o", "r", "l", "d"]);
        assert_eq!(
            detokenize(&vocab, &[0, 1, 2, 2, 4, 5, 6, 7, 2, 9]),
            "hello world"
        );
    }

    #[test]
    fn detokenize_trims_leading_space() {
        let vocab = vocab_of(&["\u{2581}hi"]);
        assert_eq!(detokenize(&vocab, &[0]), "hi");
    }

    #[test]
    fn detokenize_out_of_range_ids_skipped() {
        let vocab = vocab_of(&["a", "b"]);
        // id 99 is out of range → filtered out
        assert_eq!(detokenize(&vocab, &[0, 99, 1]), "ab");
    }

    fn timed(ids_and_frames: &[(usize, usize, usize)]) -> Vec<TokenTiming> {
        ids_and_frames
            .iter()
            .map(|&(id, start_frame, end_frame)| TokenTiming {
                id,
                start_frame,
                end_frame,
            })
            .collect()
    }

    fn spans(words: &[WordTiming]) -> Vec<(&str, f32, f32)> {
        words
            .iter()
            .map(|w| {
                let round = |v: f32| (v * 1000.0).round() / 1000.0;
                (w.word.as_str(), round(w.start), round(w.end))
            })
            .collect()
    }

    #[test]
    fn group_words_spans_the_frames_its_tokens_were_emitted_over() {
        let vocab = vocab_of(&["\u{2581}hel", "lo", "\u{2581}world"]);
        let words = group_words(&vocab, &timed(&[(0, 0, 2), (1, 2, 5), (2, 6, 9)]));
        assert_eq!(
            spans(&words),
            vec![("hello", 0.0, 0.4), ("world", 0.48, 0.72)]
        );
    }

    #[test]
    fn group_words_gives_zero_duration_tokens_a_one_frame_span() {
        // A duration-0 prediction means "another token on this frame"; a word
        // built only from those would otherwise get start == end.
        let vocab = vocab_of(&["\u{2581}hi"]);
        let words = group_words(&vocab, &timed(&[(0, 3, 3)]));
        assert_eq!(words.len(), 1);
        assert!(
            words[0].end > words[0].start,
            "{:?} is an empty span",
            words[0]
        );
    }

    /// The fixed-window path drops words in step with the text prefix its seam
    /// trim removed, which only works if the two agree on what a word is.
    #[test]
    fn group_words_yields_one_word_per_detokenized_word() {
        let cases: &[&[&str]] = &[
            &["\u{2581}hel", "lo", "\u{2581}world"],
            &["mid", "\u{2581}word", "\u{2581}start"],
            &["\u{2581}", "\u{2581}a", "b", "\u{2581}", "\u{2581}c"],
            &["\u{2581}solo"],
        ];
        for tokens in cases {
            let vocab = vocab_of(tokens);
            let ids: Vec<usize> = (0..vocab.len()).collect();
            let timings = timed(&ids.iter().map(|&i| (i, i, i + 1)).collect::<Vec<_>>());
            let text = detokenize(&vocab, &ids);
            let words = group_words(&vocab, &timings);
            assert_eq!(
                words.len(),
                text.split_whitespace().count(),
                "{tokens:?} → text {text:?}, words {words:?}"
            );
            assert_eq!(
                words.iter().map(|w| w.word.as_str()).collect::<Vec<_>>(),
                text.split_whitespace().collect::<Vec<_>>(),
                "{tokens:?}"
            );
        }
    }

    #[test]
    fn group_words_skips_out_of_range_ids_like_detokenize_does() {
        let vocab = vocab_of(&["\u{2581}a", "\u{2581}b"]);
        let words = group_words(&vocab, &timed(&[(0, 0, 1), (99, 1, 2), (1, 2, 3)]));
        assert_eq!(
            words.iter().map(|w| w.word.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn top_k_basic() {
        let arr = [0.1f32, 0.5, 0.3, 0.9, 0.2];
        // exclude index 3 (highest); next top-2 are idx 1 and idx 2
        let result = top_k_indices(&arr, 2, 3);
        assert_eq!(result, vec![1, 2]);
    }

    #[test]
    fn top_k_excludes_blank() {
        let arr = [0.9f32, 0.8, 0.7]; // blank_id = 0
        let result = top_k_indices(&arr, 2, 0);
        assert_eq!(result, vec![1, 2]);
    }

    #[test]
    fn top_k_fewer_than_k_available() {
        let arr = [0.5f32, 0.1, 0.9]; // exclude 2 → only indices 0,1 remain
        let result = top_k_indices(&arr, 5, 2);
        assert_eq!(result, vec![0, 1]);
    }

    #[test]
    fn extract_encoder_frame_layout() {
        // encoder_data is row-major [1, D=2, T'=3]:
        // d=0: [10, 11, 12], d=1: [20, 21, 22]
        let encoder_data = vec![10.0f32, 11.0, 12.0, 20.0, 21.0, 22.0];
        assert_eq!(
            extract_encoder_frame(&encoder_data, 2, 3, 0),
            vec![10.0, 20.0]
        );
        assert_eq!(
            extract_encoder_frame(&encoder_data, 2, 3, 1),
            vec![11.0, 21.0]
        );
        assert_eq!(
            extract_encoder_frame(&encoder_data, 2, 3, 2),
            vec![12.0, 22.0]
        );
    }

    #[test]
    fn extract_encoder_frame_single_dim() {
        let encoder_data = vec![7.0f32, 8.0, 9.0]; // D=1, T'=3
        assert_eq!(extract_encoder_frame(&encoder_data, 1, 3, 2), vec![9.0]);
    }

    type StepOutput = Result<(Vec<f32>, Vec<f32>, Vec<f32>)>;

    /// Fake decoder step: fixed token logits + duration logits, empty states.
    fn fixed_step(
        token_logits: Vec<f32>,
        duration_logits: Vec<f32>,
    ) -> impl FnMut(&[f32], i32, &[f32], &[f32]) -> StepOutput {
        move |_frame, _last, _s1, _s2| {
            let mut out = token_logits.clone();
            out.extend_from_slice(&duration_logits);
            Ok((out, Vec::new(), Vec::new()))
        }
    }

    #[test]
    fn beam_search_empty_encoder_returns_empty() {
        let out = beam_search(&[], 1, 0, 0, 4, |_, _, _, _| {
            panic!("step must not run for empty input")
        })
        .unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn beam_search_blank_dominant_yields_no_tokens() {
        // blank (id 0) always wins; every step advances one frame.
        let encoder = vec![0.0f32; 3];
        let step = fixed_step(vec![10.0, 0.0, 0.0, 0.0], vec![0.0, 10.0]);
        let out = beam_search(&encoder, 1, 3, 0, 4, step).unwrap();
        assert!(out.is_empty(), "blank-dominant logits produced {out:?}");
    }

    #[test]
    fn beam_search_emits_best_token_per_frame() {
        // Token 2 wins each frame with duration argmax 1 → one token per frame,
        // each carrying the frame it was emitted on and the frame the duration
        // head says it runs to.
        let encoder = vec![0.0f32; 2];
        let step = fixed_step(vec![0.0, 1.0, 10.0, 0.0], vec![0.0, 10.0]);
        let out = beam_search(&encoder, 1, 2, 0, 4, step).unwrap();
        assert_eq!(
            out,
            vec![
                TokenTiming {
                    id: 2,
                    start_frame: 0,
                    end_frame: 1
                },
                TokenTiming {
                    id: 2,
                    start_frame: 1,
                    end_frame: 2
                },
            ]
        );
    }

    #[test]
    fn beam_search_duration_zero_exhausts_step_budget_but_terminates() {
        // Non-blank token with duration argmax 0 never advances `t`; the
        // search must stop at encoder_length * MAX_TOKENS_PER_STEP instead
        // of looping forever, emitting at most one token per step.
        let encoder = vec![0.0f32; 2];
        let mut calls = 0usize;
        let out = beam_search(&encoder, 1, 2, 0, 4, |_, _, _, _| {
            calls += 1;
            Ok((vec![0.0, 10.0, 0.0, 0.0, 10.0, 0.0], Vec::new(), Vec::new()))
        })
        .unwrap();
        let max_steps = 2 * MAX_TOKENS_PER_STEP;
        assert_eq!(out.len(), max_steps, "one token per budgeted step");
        assert!(
            out.iter()
                .all(|t| t.id == 1 && t.start_frame == 0 && t.end_frame == 0),
            "{out:?}"
        );
        assert!(
            calls <= max_steps * DEFAULT_BEAM_WIDTH,
            "step ran {calls} times"
        );
    }

    #[test]
    fn beam_search_bails_on_missing_duration_logits() {
        let encoder = vec![0.0f32; 1];
        // Shorter than the vocab, and exactly the vocab with no duration head:
        // both mean a non-TDT or truncated decoder and must fail loudly.
        for len in [3usize, 8] {
            let err = beam_search(&encoder, 1, 1, 0, 8, |_, _, _, _| {
                Ok((vec![0.0; len], Vec::new(), Vec::new()))
            })
            .unwrap_err();
            assert!(err.to_string().contains("joint output"), "len={len}: {err}");
        }
    }
}
