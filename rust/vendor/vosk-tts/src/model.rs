//! Model + dictionary + config loader (vendored, trimmed).
//!
//! Differences from upstream `vosk-tts-rs::model`:
//!
//! * `Model::new` accepts ONLY an explicit `model_path: Option<&str>`. The
//!   `model_name` / `lang` arguments are kept on the signature for API
//!   parity with the published 0.1.0 crate but are no longer consulted —
//!   passing `Some(name)` or `Some(lang)` without `model_path` returns an
//!   error rather than dialing out to alphacephei.com. Kesha never relied
//!   on the auto-download path; `kesha install --tts` provisions the model
//!   via `rust/src/models.rs::download_verified` (which pins SHA-256s).
//!
//! * The `tokenizers` crate is replaced with the inline WordPiece in
//!   [`crate::tokenizer`].
//!
//! * `log::info!` calls are dropped — kesha-engine has its own dtrace! macro
//!   on the inference path; the vendored crate stays log-agnostic.

use crate::error::{Error, Result};
use crate::tokenizer::{Encoding, Tokenizer};
use ndarray::ArrayD;
use ort::session::Session;
use ort::value::Value;
use regex::Regex;
use serde::de::{self, Deserializer, Visitor};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

static RE_PUNCT_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[-,.?!;:"]"#).expect("compile RE_PUNCT_TOKEN"));

#[derive(Debug, Deserialize)]
pub struct AudioConfig {
    pub sample_rate: u32,
}

#[derive(Debug, Deserialize)]
pub struct InferenceConfig {
    #[serde(default = "default_noise_level")]
    pub noise_level: f32,
    #[serde(default = "default_speech_rate")]
    pub speech_rate: f32,
    #[serde(default = "default_duration_noise_level")]
    pub duration_noise_level: f32,
    #[serde(default = "default_scale")]
    pub scale: f32,
}

fn default_noise_level() -> f32 {
    0.8
}
fn default_speech_rate() -> f32 {
    1.0
}
fn default_duration_noise_level() -> f32 {
    0.8
}
fn default_scale() -> f32 {
    1.0
}

#[derive(Debug, Clone)]
pub enum PhonemeIdValue {
    Single(i64),
    Multiple(Vec<i64>),
}

impl<'de> Deserialize<'de> for PhonemeIdValue {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct PhonemeIdValueVisitor;

        impl<'de> Visitor<'de> for PhonemeIdValueVisitor {
            type Value = PhonemeIdValue;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an integer or a list of integers")
            }

            fn visit_i64<E>(self, value: i64) -> std::result::Result<PhonemeIdValue, E>
            where
                E: de::Error,
            {
                Ok(PhonemeIdValue::Single(value))
            }

            fn visit_u64<E>(self, value: u64) -> std::result::Result<PhonemeIdValue, E>
            where
                E: de::Error,
            {
                Ok(PhonemeIdValue::Single(value as i64))
            }

            fn visit_seq<A>(self, mut seq: A) -> std::result::Result<PhonemeIdValue, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                let mut vec = Vec::new();
                while let Some(elem) = seq.next_element()? {
                    vec.push(elem);
                }
                Ok(PhonemeIdValue::Multiple(vec))
            }
        }

        deserializer.deserialize_any(PhonemeIdValueVisitor)
    }
}

#[derive(Debug, Deserialize)]
pub struct ModelConfig {
    pub audio: AudioConfig,
    pub inference: InferenceConfig,
    pub phoneme_id_map: HashMap<String, PhonemeIdValue>,
    #[serde(default)]
    pub model_type: Option<String>,
    #[serde(default)]
    pub no_blank: Option<i64>,
}

pub struct Model {
    pub onnx: Session,
    pub dic: HashMap<String, String>,
    pub config: ModelConfig,
    pub tokenizer: Option<Tokenizer>,
    pub bert_onnx: Option<RefCell<Session>>,
}

impl Model {
    /// Load a model from `model_path`. The `_model_name` / `_lang` arguments
    /// are accepted for upstream API parity but ignored — auto-download was
    /// removed from the vendored crate (see module docs).
    pub fn new(
        model_path: Option<&str>,
        _model_name: Option<&str>,
        _lang: Option<&str>,
    ) -> Result<Self> {
        let model_path = match model_path {
            Some(p) => PathBuf::from(p),
            None => {
                return Err(Error::DictionaryRead {
                    path: "<unset>".into(),
                    source: std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "vosk-tts (vendored): an explicit model_path is required",
                    ),
                });
            }
        };

        // Load ONNX model.
        let onnx = Session::builder()?
            .commit_from_file(model_path.join("model.onnx"))
            .map_err(Error::OnnxModelLoad)?;

        let dic = Self::load_dictionary(&model_path)?;
        let config = Self::load_config(&model_path)?;

        // Load BERT tokenizer + ONNX session if `bert/vocab.txt` exists in the
        // model bundle. Russian multi-speaker model ships them; legacy models
        // may not.
        let bert_path = model_path.join("bert");
        let (tokenizer, bert_onnx) = if bert_path.join("vocab.txt").exists() {
            let tok = Tokenizer::from_vocab_file(&bert_path.join("vocab.txt"))?;
            let bert_session = Session::builder()?
                .commit_from_file(bert_path.join("model.onnx"))
                .ok();
            (Some(tok), bert_session.map(RefCell::new))
        } else {
            (None, None)
        };

        Ok(Model {
            onnx,
            dic,
            config,
            tokenizer,
            bert_onnx,
        })
    }

    fn load_dictionary(model_path: &Path) -> Result<HashMap<String, String>> {
        let mut dic = HashMap::new();
        let mut probs: HashMap<String, f32> = HashMap::new();

        let dict_path = model_path.join("dictionary");
        let content = fs::read_to_string(&dict_path).map_err(|e| Error::DictionaryRead {
            path: dict_path.to_string_lossy().to_string(),
            source: e,
        })?;

        for line in content.lines() {
            let parts: Vec<&str> = line.splitn(3, char::is_whitespace).collect();
            if parts.len() >= 3 {
                let word = parts[0];
                let prob: f32 = parts[1].parse().unwrap_or(0.0);
                let phonemes = parts[2];

                let current_prob = probs.get(word).copied().unwrap_or(0.0);
                if prob > current_prob {
                    dic.insert(word.to_string(), phonemes.to_string());
                    probs.insert(word.to_string(), prob);
                }
            }
        }

        Ok(dic)
    }

    fn load_config(model_path: &Path) -> Result<ModelConfig> {
        let config_path = model_path.join("config.json");
        let content = fs::read_to_string(&config_path).map_err(|e| Error::ConfigRead {
            path: config_path.to_string_lossy().to_string(),
            source: e,
        })?;
        serde_json::from_str(&content).map_err(Error::ConfigParse)
    }

    /// Run BERT and return the per-(non-subword) token embeddings.
    /// Returns `None` when the model has no tokenizer / BERT session, or any
    /// inference step fails — callers fall back to zero-embeddings.
    pub fn get_word_bert(&self, text: &str, nopunc: bool) -> Option<Vec<Vec<f32>>> {
        let tokenizer = self.tokenizer.as_ref()?;
        let bert_session_ref = self.bert_onnx.as_ref()?;
        let mut bert_session = bert_session_ref.borrow_mut();

        let text_clean = text.replace(['+', '_'], "");
        let Encoding {
            ids,
            tokens,
            attention_mask,
            type_ids,
        } = tokenizer.encode(&text_clean, true);

        let ids_i64: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
        let mask_i64: Vec<i64> = attention_mask.iter().map(|&x| x as i64).collect();
        let type_i64: Vec<i64> = type_ids.iter().map(|&x| x as i64).collect();

        let input_ids_array =
            ArrayD::<i64>::from_shape_vec(vec![1, ids_i64.len()], ids_i64).ok()?;
        let attention_mask_array =
            ArrayD::<i64>::from_shape_vec(vec![1, mask_i64.len()], mask_i64).ok()?;
        let type_ids_array =
            ArrayD::<i64>::from_shape_vec(vec![1, type_i64.len()], type_i64).ok()?;

        let inputs = ort::inputs![
            "input_ids" => Value::from_array(input_ids_array).ok()?,
            "attention_mask" => Value::from_array(attention_mask_array).ok()?,
            "token_type_ids" => Value::from_array(type_ids_array).ok()?,
        ];

        let outputs = bert_session.run(inputs).ok()?;
        let (_shape, data) = outputs[0].try_extract_tensor::<f32>().ok()?;

        let hidden_size = 768;
        let mut selected: Vec<Vec<f32>> = Vec::new();
        for (i, token) in tokens.iter().enumerate() {
            if !token.starts_with('#') {
                let skip_punc = nopunc && RE_PUNCT_TOKEN.is_match(token);
                if !skip_punc {
                    let start = i * hidden_size;
                    let end = start + hidden_size;
                    selected.push(data[start..end].to_vec());
                }
            }
        }

        Some(selected)
    }
}
