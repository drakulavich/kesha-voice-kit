//! Phoneme assembly + ONNX inference (vendored, trimmed).
//!
//! Diff vs upstream `vosk-tts-rs::synth`:
//!
//! * `log::info!` calls dropped (kesha-engine uses its own dtrace).
//! * The `synth()` WAV-writer method (which used `hound`) is removed; the
//!   only surviving entry point is [`Synth::synth_audio`]. Callers wrap the
//!   `Vec<i16>` PCM output themselves — kesha's `tts::wav::encode_wav` does
//!   it for free.
//! * Public `G2PResult` and the four `g2p_*` methods are dropped from the
//!   pub surface (kept module-private) — kesha never invoked them directly.

use crate::error::{Error, Result};
use crate::g2p;
use crate::model::{Model, PhonemeIdValue};
use ndarray::ArrayD;
use ort::value::Value;
use regex::Regex;
use std::sync::LazyLock;

// Hoisted from per-call `Regex::new` sites in the g2p_* methods — pattern compilation
// is non-trivial (NFA/DFA construction) and these strings are constants, so once is enough.
static RE_PUNCT_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"([,.?!;:"() ])"#).expect("compile RE_PUNCT_SPLIT"));
static RE_PUNCT_MULTISTREAM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\.\.\.|- |[ ,.?!;:"()])"#).expect("compile RE_PUNCT_MULTISTREAM")
});
static RE_PUNCT_MULTISTREAM_SCALES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\.\.\.|- |[ ,.?!;:"()_])"#).expect("compile RE_PUNCT_MULTISTREAM_SCALES")
});

#[derive(Clone, Default)]
pub struct Synth;

fn get_phoneme_id_single(model: &Model, phoneme: &str) -> i64 {
    match model.config.phoneme_id_map.get(phoneme) {
        Some(PhonemeIdValue::Single(id)) => *id,
        Some(PhonemeIdValue::Multiple(ids)) => ids[0],
        None => 0,
    }
}

fn get_phoneme_ids(model: &Model, phoneme: &str) -> Vec<i64> {
    match model.config.phoneme_id_map.get(phoneme) {
        Some(PhonemeIdValue::Single(id)) => vec![*id],
        Some(PhonemeIdValue::Multiple(ids)) => ids.clone(),
        None => vec![0],
    }
}

fn audio_float_to_int16(audio: &[f32], max_wav_value: f32) -> Vec<i16> {
    audio
        .iter()
        .map(|&sample| {
            let normalized = sample * max_wav_value;
            let clipped = normalized.clamp(-max_wav_value, max_wav_value);
            clipped as i16
        })
        .collect()
}

struct G2PResult {
    text_data: Vec<i64>,
    text_shape: Vec<usize>,
    text_lengths: Vec<i64>,
    bert_data: Vec<f32>,
    bert_shape: Vec<usize>,
    duration_extra_data: Option<Vec<f32>>,
    duration_extra_shape: Option<Vec<usize>>,
}

impl G2PResult {
    fn multistream(
        text_data: Vec<i64>,
        t: usize,
        bert_data: Vec<f32>,
        duration_extra_data: Option<Vec<f32>>,
    ) -> Self {
        let duration_extra_shape = duration_extra_data.as_ref().map(|_| vec![1, t]);
        G2PResult {
            text_data,
            text_shape: vec![1, 5, t],
            text_lengths: vec![t as i64],
            bert_data,
            bert_shape: vec![1, 768, t],
            duration_extra_data,
            duration_extra_shape,
        }
    }

    fn standard(text_data: Vec<i64>, t: usize, bert_data: Vec<f32>) -> Self {
        G2PResult {
            text_data,
            text_shape: vec![1, t],
            text_lengths: vec![t as i64],
            bert_data,
            bert_shape: vec![1, 768, t],
            duration_extra_data: None,
            duration_extra_shape: None,
        }
    }

    fn no_embeddings(text_data: Vec<i64>, t: usize) -> Self {
        let hidden_size = 768;
        G2PResult {
            text_data,
            text_shape: vec![1, t],
            text_lengths: vec![t as i64],
            bert_data: vec![0.0f32; hidden_size * t],
            bert_shape: vec![1, hidden_size, t],
            duration_extra_data: None,
            duration_extra_shape: None,
        }
    }
}

impl Synth {
    pub fn new() -> Self {
        Synth {}
    }

    /// Synthesize audio from `text` and return int16 PCM at
    /// `model.config.audio.sample_rate`.
    #[allow(clippy::too_many_arguments)]
    pub fn synth_audio(
        &self,
        model: &mut Model,
        text: &str,
        speaker_id: Option<i64>,
        noise_level: Option<f32>,
        speech_rate: Option<f32>,
        duration_noise_level: Option<f32>,
        scale: Option<f32>,
    ) -> Result<Vec<i16>> {
        let noise_level = noise_level.unwrap_or(model.config.inference.noise_level);
        let speech_rate = speech_rate.unwrap_or(model.config.inference.speech_rate);
        let duration_noise_level =
            duration_noise_level.unwrap_or(model.config.inference.duration_noise_level);
        let scale = scale.unwrap_or(model.config.inference.scale);

        let text = text.trim().replace('—', "-");

        let model_type = model.config.model_type.as_deref().unwrap_or("");
        let has_tokenizer = model.tokenizer.is_some();
        let no_blank = model.config.no_blank.unwrap_or(0);

        let g2p_result = match (model_type, has_tokenizer, no_blank) {
            ("multistream_v3", true, _) => self.g2p_multistream_scales(model, &text)?,
            ("multistream_v2", _, _) => self.g2p_multistream(model, &text, true)?,
            ("multistream_v1", _, _) => self.g2p_multistream(model, &text, false)?,
            (_, true, nb) if nb != 0 => self.g2p_noblank(model, &text)?,
            (_, true, 0) => self.g2p_with_embeddings(model, &text)?,
            _ => self.g2p_no_embeddings(model, &text)?,
        };

        let scales = vec![noise_level, 1.0 / speech_rate, duration_noise_level];
        let speaker_id = speaker_id.unwrap_or(0);
        let sid = vec![speaker_id];

        let input_tensor = Value::from_array(
            ArrayD::<i64>::from_shape_vec(g2p_result.text_shape.clone(), g2p_result.text_data)
                .unwrap(),
        )?;
        let input_lengths_tensor = Value::from_array(
            ArrayD::<i64>::from_shape_vec(vec![1], g2p_result.text_lengths).unwrap(),
        )?;
        let scales_tensor =
            Value::from_array(ArrayD::<f32>::from_shape_vec(vec![3], scales).unwrap())?;
        let sid_tensor = Value::from_array(ArrayD::<i64>::from_shape_vec(vec![1], sid).unwrap())?;
        let bert_tensor = Value::from_array(
            ArrayD::<f32>::from_shape_vec(g2p_result.bert_shape.clone(), g2p_result.bert_data)
                .unwrap(),
        )?;

        let mut inputs = ort::inputs![
            "input" => input_tensor,
            "input_lengths" => input_lengths_tensor,
            "scales" => scales_tensor,
            "sid" => sid_tensor,
            "bert" => bert_tensor,
        ];

        if let (Some(dur_data), Some(dur_shape)) = (
            g2p_result.duration_extra_data,
            g2p_result.duration_extra_shape,
        ) {
            let dur_tensor =
                Value::from_array(ArrayD::<f32>::from_shape_vec(dur_shape, dur_data).unwrap())?;
            inputs.push(("phone_duration_extra".into(), dur_tensor.into()));
        }

        let outputs = model.onnx.run(inputs)?;
        let audio_value = &outputs[0];
        let (_audio_shape, audio_data) = audio_value
            .try_extract_tensor::<f32>()
            .map_err(|e| Error::AudioTensorExtract(e.to_string()))?;

        let audio_scaled: Vec<f32> = audio_data.iter().map(|&x| x * scale).collect();
        Ok(audio_float_to_int16(&audio_scaled, 32767.0))
    }

    fn g2p_with_embeddings(&self, model: &Model, text: &str) -> Result<G2PResult> {
        let re = &*RE_PUNCT_SPLIT;
        let mut phonemes = vec!["^".to_string()];
        let bert_embeddings = model.get_word_bert(text, false).unwrap_or_default();
        let mut word_indices = vec![0usize];
        let mut word_index = 1;

        for word in re.split(&text.to_lowercase()) {
            if word.is_empty() {
                continue;
            }
            if re.is_match(word) || word == "-" {
                phonemes.push(word.to_string());
                word_indices.push(word_index);
            } else if let Some(phoneme_str) = model.dic.get(word) {
                for p in phoneme_str.split_whitespace() {
                    phonemes.push(p.to_string());
                    word_indices.push(word_index);
                }
            } else {
                let converted = g2p::convert(word);
                for p in converted.split_whitespace() {
                    phonemes.push(p.to_string());
                    word_indices.push(word_index);
                }
            }
            if word != " " {
                word_index += 1;
            }
        }

        phonemes.push("$".to_string());
        word_indices.push(word_index);

        let hidden_size = 768;
        let n = phonemes.len();
        let t = 2 * n - 1;

        let mut phoneme_ids = Vec::with_capacity(t);
        let mut bert_data = Vec::with_capacity(t * hidden_size);

        let first_ids = get_phoneme_ids(model, &phonemes[0]);
        phoneme_ids.extend(&first_ids);
        Self::add_bert_emb_at(
            &mut bert_data,
            word_indices[0],
            &bert_embeddings,
            hidden_size,
        );

        for i in 1..phonemes.len() {
            phoneme_ids.push(0);
            Self::add_bert_emb_at(
                &mut bert_data,
                word_indices[i],
                &bert_embeddings,
                hidden_size,
            );
            let ids = get_phoneme_ids(model, &phonemes[i]);
            phoneme_ids.extend(&ids);
            Self::add_bert_emb_at(
                &mut bert_data,
                word_indices[i],
                &bert_embeddings,
                hidden_size,
            );
        }

        let bert_data = Self::transpose_bert(bert_data, t, hidden_size);
        Ok(G2PResult::standard(phoneme_ids, t, bert_data))
    }

    fn g2p_noblank(&self, model: &Model, text: &str) -> Result<G2PResult> {
        let re = &*RE_PUNCT_SPLIT;
        let mut phonemes = vec!["^".to_string()];
        let bert_embeddings = model.get_word_bert(text, false).unwrap_or_default();
        let mut word_indices = vec![0usize];
        let mut word_index = 1;

        for word in re.split(&text.to_lowercase()) {
            if word.is_empty() {
                continue;
            }
            if re.is_match(word) || word == "-" {
                phonemes.push(word.to_string());
                word_indices.push(word_index);
            } else if let Some(phoneme_str) = model.dic.get(word) {
                for p in phoneme_str.split_whitespace() {
                    phonemes.push(p.to_string());
                    word_indices.push(word_index);
                }
            } else {
                let converted = g2p::convert(word);
                for p in converted.split_whitespace() {
                    phonemes.push(p.to_string());
                    word_indices.push(word_index);
                }
            }
            if word != " " {
                word_index += 1;
            }
        }

        phonemes.push("$".to_string());
        word_indices.push(word_index);

        let hidden_size = 768;
        let mut phoneme_ids = vec![];
        let mut bert_data = Vec::new();

        for i in 0..phonemes.len() {
            let ids = get_phoneme_ids(model, &phonemes[i]);
            phoneme_ids.extend(&ids);
            Self::add_bert_emb_at(
                &mut bert_data,
                word_indices[i],
                &bert_embeddings,
                hidden_size,
            );
        }

        let t = phoneme_ids.len();
        let bert_data = Self::transpose_bert(bert_data, t, hidden_size);
        Ok(G2PResult::standard(phoneme_ids, t, bert_data))
    }

    fn g2p_multistream(&self, model: &Model, text: &str, word_pos: bool) -> Result<G2PResult> {
        let re = &*RE_PUNCT_MULTISTREAM;
        let text_clean = text.replace(" -", "- ");
        let bert_embeddings = model.get_word_bert(&text_clean, true).unwrap_or_default();

        let mut tokens: Vec<String> = Vec::new();
        let mut last_end = 0;
        for mat in re.find_iter(&text_clean) {
            if mat.start() > last_end {
                tokens.push(text_clean[last_end..mat.start()].to_string());
            }
            tokens.push(mat.as_str().to_string());
            last_end = mat.end();
        }
        if last_end < text_clean.len() {
            tokens.push(text_clean[last_end..].to_string());
        }

        let mut phonemes: Vec<(String, Vec<String>, i32, usize)> =
            vec![("^".to_string(), vec![], 0, 0)];
        let mut cur_punc = vec![];
        let mut in_quote = 0;
        let mut bert_word_index = 1;

        for word in &tokens {
            if word.is_empty() {
                continue;
            }
            if word == "\"" {
                in_quote = if in_quote == 1 { 0 } else { 1 };
                continue;
            }
            if word == "- " || word == "-" {
                cur_punc.push('-'.to_string());
                continue;
            }
            if re.is_match(word) && word != " " {
                cur_punc.push(word.to_string());
                continue;
            }
            if word == " " {
                phonemes.push((" ".to_string(), cur_punc.clone(), in_quote, bert_word_index));
                cur_punc = vec![];
                continue;
            }

            let word_phonemes_raw =
                if let Some(dic_entry) = model.dic.get(word.to_lowercase().as_str()) {
                    dic_entry
                        .split_whitespace()
                        .map(String::from)
                        .collect::<Vec<_>>()
                } else {
                    g2p::convert(word)
                        .split_whitespace()
                        .map(String::from)
                        .collect()
                };

            let word_phonemes = if word_pos {
                Self::add_pos(&word_phonemes_raw)
            } else {
                word_phonemes_raw
            };

            for p in &word_phonemes {
                phonemes.push((p.clone(), vec![], in_quote, bert_word_index));
            }
            cur_punc = vec![];
            bert_word_index += 1;
        }

        phonemes.push((" ".to_string(), cur_punc.clone(), in_quote, bert_word_index));
        phonemes.push(("$".to_string(), vec![], 0, bert_word_index));

        let mut last_punc = " ".to_string();
        let mut last_sentence_punc = " ".to_string();
        let mut lp_phonemes: Vec<(i64, i64, i64, i64, i64)> = vec![];
        let mut rev_bert_indices: Vec<usize> = vec![];

        for p in phonemes.iter().rev() {
            let punc_list = &p.1;
            if punc_list.iter().any(|x| x == "...") {
                last_sentence_punc = "...".to_string();
            } else if punc_list.iter().any(|x| x == ".") {
                last_sentence_punc = ".".to_string();
            } else if punc_list.iter().any(|x| x == "!") {
                last_sentence_punc = "!".to_string();
            } else if punc_list.iter().any(|x| x == "?") {
                last_sentence_punc = "?".to_string();
            } else if punc_list.iter().any(|x| x == "-") {
                last_sentence_punc = "-".to_string();
            }
            if !punc_list.is_empty() {
                last_punc = punc_list[0].clone();
            }
            let cur_punc_str = if !punc_list.is_empty() {
                punc_list[0].clone()
            } else {
                "_".to_string()
            };
            let phoneme_id = get_phoneme_id_single(model, &p.0);
            let cur_punc_id = get_phoneme_id_single(model, &cur_punc_str);
            let last_punc_id = get_phoneme_id_single(model, &last_punc);
            let last_sentence_punc_id = get_phoneme_id_single(model, &last_sentence_punc);
            lp_phonemes.push((
                phoneme_id,
                cur_punc_id,
                p.2 as i64,
                last_punc_id,
                last_sentence_punc_id,
            ));
            rev_bert_indices.push(p.3);
        }
        lp_phonemes.reverse();
        rev_bert_indices.reverse();

        let t = lp_phonemes.len();
        let hidden_size = 768;
        let mut text_data = Vec::with_capacity(t * 5);
        for channel in 0..5 {
            for (p0, p1, p2, p3, p4) in &lp_phonemes {
                let val = match channel {
                    0 => *p0,
                    1 => *p1,
                    2 => *p2,
                    3 => *p3,
                    _ => *p4,
                };
                text_data.push(val);
            }
        }

        let bert_raw: Vec<Vec<f32>> = rev_bert_indices
            .iter()
            .map(|&bert_idx| {
                if bert_idx < bert_embeddings.len() {
                    bert_embeddings[bert_idx].clone()
                } else {
                    vec![0.0f32; hidden_size]
                }
            })
            .collect();

        let mut bert_data = Vec::with_capacity(t * hidden_size);
        #[allow(clippy::needless_range_loop)]
        for ch in 0..hidden_size {
            for phoneme in 0..t {
                bert_data.push(bert_raw[phoneme][ch]);
            }
        }

        Ok(G2PResult::multistream(text_data, t, bert_data, None))
    }

    fn g2p_multistream_scales(&self, model: &Model, text: &str) -> Result<G2PResult> {
        let re = &*RE_PUNCT_MULTISTREAM_SCALES;
        let text_clean = text.replace(" -", "- ");
        let bert_embeddings = model.get_word_bert(&text_clean, true).unwrap_or_default();

        let mut tokens: Vec<String> = Vec::new();
        let mut last_end = 0;
        for mat in re.find_iter(&text_clean) {
            if mat.start() > last_end {
                tokens.push(text_clean[last_end..mat.start()].to_string());
            }
            tokens.push(mat.as_str().to_string());
            last_end = mat.end();
        }
        if last_end < text_clean.len() {
            tokens.push(text_clean[last_end..].to_string());
        }

        let mut phonemes: Vec<(String, Vec<String>, i32, usize)> =
            vec![("^".to_string(), vec![], 0, 0)];
        let mut cur_punc = vec![];
        let mut in_quote = 0;
        let mut bert_word_index = 1;

        for word in &tokens {
            if word.is_empty() {
                continue;
            }
            if word == "\"" {
                in_quote = if in_quote == 1 { 0 } else { 1 };
                continue;
            }
            if word == "- " || word == "-" {
                cur_punc.push('-'.to_string());
                continue;
            }
            if re.is_match(word) && word != " " {
                cur_punc.push(word.to_string());
                continue;
            }
            if word == " " {
                phonemes.push((" ".to_string(), cur_punc.clone(), in_quote, bert_word_index));
                cur_punc = vec![];
                continue;
            }

            let word_lower = word.to_lowercase();
            let word_phonemes_raw = if let Some(dic_entry) = model.dic.get(word_lower.as_str()) {
                dic_entry
                    .split_whitespace()
                    .map(String::from)
                    .collect::<Vec<_>>()
            } else {
                g2p::convert(word)
                    .split_whitespace()
                    .map(String::from)
                    .collect()
            };
            let word_phonemes = Self::add_pos(&word_phonemes_raw);

            for p in &word_phonemes {
                phonemes.push((p.clone(), vec![], in_quote, bert_word_index));
            }
            cur_punc = vec![];
            bert_word_index += 1;
        }

        phonemes.push((" ".to_string(), cur_punc.clone(), in_quote, bert_word_index));
        phonemes.push(("$".to_string(), vec![], 0, bert_word_index));

        let mut last_punc = " ".to_string();
        let mut last_sentence_punc = " ".to_string();
        let mut lp_phonemes: Vec<(i64, i64, i64, i64, i64)> = vec![];
        let mut rev_bert_indices: Vec<usize> = vec![];
        let mut phone_duration_extra: Vec<f32> = vec![];

        for p in phonemes.iter().rev() {
            let punc_list = &p.1;
            if punc_list.iter().any(|x| x == "...") {
                last_sentence_punc = "...".to_string();
            } else if punc_list.iter().any(|x| x == ".") {
                last_sentence_punc = ".".to_string();
            } else if punc_list.iter().any(|x| x == "!") {
                last_sentence_punc = "!".to_string();
            } else if punc_list.iter().any(|x| x == "?") {
                last_sentence_punc = "?".to_string();
            } else if punc_list.iter().any(|x| x == "-") {
                last_sentence_punc = "-".to_string();
            }
            let phone_duration_ext = if punc_list.iter().any(|x| x == "_") {
                20.0
            } else {
                0.0
            };
            if !punc_list.is_empty() {
                last_punc = punc_list[0].clone();
            }
            let cur_punc_str = if !punc_list.is_empty() {
                punc_list[0].clone()
            } else {
                "_".to_string()
            };
            let phoneme_id = get_phoneme_id_single(model, &p.0);
            let cur_punc_id = get_phoneme_id_single(model, &cur_punc_str);
            let last_punc_id = get_phoneme_id_single(model, &last_punc);
            let last_sentence_punc_id = get_phoneme_id_single(model, &last_sentence_punc);
            lp_phonemes.push((
                phoneme_id,
                cur_punc_id,
                p.2 as i64,
                last_punc_id,
                last_sentence_punc_id,
            ));
            rev_bert_indices.push(p.3);
            phone_duration_extra.push(phone_duration_ext);
        }
        lp_phonemes.reverse();
        rev_bert_indices.reverse();
        phone_duration_extra.reverse();

        let t = lp_phonemes.len();
        let hidden_size = 768;
        let mut text_data = Vec::with_capacity(t * 5);
        for channel in 0..5 {
            for (p0, p1, p2, p3, p4) in &lp_phonemes {
                let val = match channel {
                    0 => *p0,
                    1 => *p1,
                    2 => *p2,
                    3 => *p3,
                    _ => *p4,
                };
                text_data.push(val);
            }
        }

        let bert_raw: Vec<Vec<f32>> = rev_bert_indices
            .iter()
            .map(|&bert_idx| {
                if bert_idx < bert_embeddings.len() {
                    bert_embeddings[bert_idx].clone()
                } else {
                    vec![0.0f32; hidden_size]
                }
            })
            .collect();
        let mut bert_data = Vec::with_capacity(t * hidden_size);
        #[allow(clippy::needless_range_loop)]
        for ch in 0..hidden_size {
            for phoneme in 0..t {
                bert_data.push(bert_raw[phoneme][ch]);
            }
        }

        Ok(G2PResult::multistream(
            text_data,
            t,
            bert_data,
            Some(phone_duration_extra),
        ))
    }

    fn g2p_no_embeddings(&self, model: &Model, text: &str) -> Result<G2PResult> {
        let re = &*RE_PUNCT_SPLIT;
        let mut phonemes = vec!["^".to_string()];

        for word in re.split(&text.to_lowercase()) {
            if word.is_empty() {
                continue;
            }
            if re.is_match(word) || word == "-" {
                phonemes.push(word.to_string());
            } else if let Some(phoneme_str) = model.dic.get(word) {
                for p in phoneme_str.split_whitespace() {
                    phonemes.push(p.to_string());
                }
            } else {
                let converted = g2p::convert(word);
                for p in converted.split_whitespace() {
                    phonemes.push(p.to_string());
                }
            }
        }
        phonemes.push("$".to_string());

        let first_ids = get_phoneme_ids(model, &phonemes[0]);
        let mut phoneme_ids: Vec<i64> = Vec::new();
        phoneme_ids.extend(&first_ids);
        for ph in phonemes.iter().skip(1) {
            phoneme_ids.push(0);
            let ids = get_phoneme_ids(model, ph);
            phoneme_ids.extend(&ids);
        }

        let t = phoneme_ids.len();
        Ok(G2PResult::no_embeddings(phoneme_ids, t))
    }

    fn transpose_bert(bert_data: Vec<f32>, num_phonemes: usize, hidden_size: usize) -> Vec<f32> {
        let mut transposed = Vec::with_capacity(bert_data.len());
        for ch in 0..hidden_size {
            for phoneme in 0..num_phonemes {
                transposed.push(bert_data[phoneme * hidden_size + ch]);
            }
        }
        transposed
    }

    fn add_bert_emb_at(
        embeddings: &mut Vec<f32>,
        word_index: usize,
        bert_embeddings: &[Vec<f32>],
        hidden_size: usize,
    ) {
        if word_index < bert_embeddings.len() {
            embeddings.extend(&bert_embeddings[word_index]);
        } else {
            embeddings.extend(&vec![0.0f32; hidden_size]);
        }
    }

    fn add_pos(phonemes: &[String]) -> Vec<String> {
        if phonemes.len() == 1 {
            return vec![format!("{}_S", phonemes[0])];
        }
        let mut res = vec![];
        for (i, p) in phonemes.iter().enumerate() {
            if i == 0 {
                res.push(format!("{}_B", p));
            } else if i == phonemes.len() - 1 {
                res.push(format!("{}_E", p));
            } else {
                res.push(format!("{}_I", p));
            }
        }
        res
    }
}
