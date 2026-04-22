//! Grapheme-to-phoneme via CharsiuG2P ByT5-tiny ONNX (#123 — replaces
//! espeak-ng). Three ORT sessions (encoder, decoder, decoder-with-past)
//! plus greedy decoding with explicit KV-cache management.
//!
//! The ByT5 tokenizer is byte-level with a `+3` offset (PAD=0, EOS=1,
//! UNK=2 reserved; actual byte tokens start at 3). Prompts look like
//! `"<{lang}>: {word}"` where `{lang}` is a CharsiuG2P code (e.g. `eng-us`).
//!
//! Session lifetime: loaded once per `text_to_ipa` call, reused across
//! all words in the input. This matches the Kokoro/Piper/VAD pattern —
//! per-call load amortized over all words in one synthesis.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use ndarray::{Array2, Array3, Array4};
use ort::session::Session;
use ort::value::Value;

use crate::models;

const PAD: i64 = 0;
const EOS: i64 = 1;
const BYTE_OFFSET: i64 = 3;
const VOCAB_SIZE: usize = 384;
const MAX_DECODE_STEPS: usize = 128;
const NUM_DECODER_LAYERS: usize = 4;

struct G2pSessions {
    encoder: Session,
    decoder: Session,
    decoder_with_past: Session,
}

impl G2pSessions {
    fn load() -> Result<Self> {
        let cache = models::cache_dir();
        let dir = cache.join("models").join("g2p").join("byt5-tiny");
        anyhow::ensure!(
            dir.exists(),
            "G2P model not installed. Run: kesha install --tts"
        );
        let encoder = build_session(&dir.join("encoder_model.onnx")).context("load g2p encoder")?;
        let decoder = build_session(&dir.join("decoder_model.onnx")).context("load g2p decoder")?;
        let decoder_with_past = build_session(&dir.join("decoder_with_past_model.onnx"))
            .context("load g2p decoder_with_past")?;
        Ok(Self {
            encoder,
            decoder,
            decoder_with_past,
        })
    }
}

fn build_session(path: &Path) -> Result<Session> {
    // `ort::Error<SessionBuilder>` isn't Send in 2.0.0-rc.12 so it can't
    // convert through `?` into `anyhow::Error`. Inline `map_err` at each
    // boundary — see the spike doc's "ort API gotchas" section.
    Session::builder()
        .map_err(|e| anyhow::anyhow!("ort session builder: {e}"))?
        .commit_from_file(path)
        .with_context(|| format!("open {}", path.display()))
}

/// Map espeak-style language codes to CharsiuG2P prompt codes.
///
/// The upstream checkpoint uses non-standard ISO-ish suffixes — Portuguese
/// is `por-bz` (Brazilian) / `por-po` (European) rather than `-br`/`-pt`,
/// per the training dictionary names in
/// <https://github.com/lingjzhu/CharsiuG2P/tree/main/dicts>. Every code in
/// this table is verified against that directory listing; "ISO-looking"
/// substitutions (e.g. `por-br`) would silently produce garbage because
/// the model has never seen that prompt.
pub fn charsiu_lang(espeak: &str) -> Result<&'static str> {
    Ok(match espeak.to_ascii_lowercase().as_str() {
        "en-us" => "eng-us",
        "en" | "en-gb" | "en-uk" => "eng-uk",
        "ru" | "ru-ru" => "rus",
        "fr" | "fr-fr" => "fra",
        "de" | "de-de" => "ger",
        "es" | "es-es" => "spa",
        "it" | "it-it" => "ita",
        "pt" | "pt-br" => "por-bz",
        "pt-pt" => "por-po",
        "ja" | "ja-jp" | "jp" => "jpn",
        "zh" | "zh-cn" | "cmn" => "cmn",
        "hi" | "hi-in" => "hin",
        _ => anyhow::bail!("unsupported G2P lang '{}'", espeak),
    })
}

/// Byte-level tokenization: UTF-8 bytes + 3 (ByT5 reserves 0/1/2), with
/// trailing EOS. The prompt format (`<lang>: word`) is what the CharsiuG2P
/// checkpoint was trained on; matches the Python reference exactly.
fn tokenize(charsiu_code: &str, word: &str) -> Vec<i64> {
    let prompt = format!("<{charsiu_code}>: {word}");
    let mut ids: Vec<i64> = prompt.bytes().map(|b| b as i64 + BYTE_OFFSET).collect();
    ids.push(EOS);
    ids
}

/// Decode a run of token IDs back to UTF-8. IDs below `BYTE_OFFSET` are
/// special tokens (PAD/EOS/UNK) and are dropped silently.
fn detokenize(ids: &[i64]) -> String {
    let bytes: Vec<u8> = ids
        .iter()
        .filter_map(|&id| {
            if id >= BYTE_OFFSET && id - BYTE_OFFSET < 256 {
                Some((id - BYTE_OFFSET) as u8)
            } else {
                None
            }
        })
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn argmax(logits: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in logits.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    best
}

/// Convert one word to IPA. Sessions are passed in so the caller can amortize
/// the ~100 ms session-load across all words in the input.
fn g2p_word(sess: &mut G2pSessions, charsiu_code: &str, word: &str) -> Result<String> {
    let input_ids = tokenize(charsiu_code, word);
    let n_in = input_ids.len();

    // --- Encoder ---
    let enc_ids = Array2::<i64>::from_shape_vec((1, n_in), input_ids.clone())?;
    // `Value::from_array` consumes its input, so the attention mask is a
    // fresh all-ones Array2 at each boundary (encoder, step 0, and every
    // decode step below). `Array2::ones` is an inline allocation rather
    // than a clone of an outer binding — same memory, clearer intent.
    let enc_out = sess.encoder.run(ort::inputs![
        "input_ids" => Value::from_array(enc_ids)?,
        "attention_mask" => Value::from_array(Array2::<i64>::ones((1, n_in)))?,
    ])?;
    let (h_shape, h_data) = enc_out["last_hidden_state"].try_extract_tensor::<f32>()?;
    let h_shape_v: Vec<usize> = h_shape.iter().map(|&x| x as usize).collect();
    let encoder_hidden =
        Array3::<f32>::from_shape_vec((h_shape_v[0], h_shape_v[1], h_shape_v[2]), h_data.to_vec())?;

    // --- Decoder step 0 (seeded with PAD) ---
    let seed = Array2::<i64>::from_shape_vec((1, 1), vec![PAD])?;
    let step0 = sess.decoder.run(ort::inputs![
        "input_ids" => Value::from_array(seed)?,
        "encoder_attention_mask" => Value::from_array(Array2::<i64>::ones((1, n_in)))?,
        "encoder_hidden_states" => Value::from_array(encoder_hidden)?,
    ])?;

    let (_, logits0) = step0["logits"].try_extract_tensor::<f32>()?;
    anyhow::ensure!(
        logits0.len() >= VOCAB_SIZE,
        "g2p decoder logits too small: got {}, need {VOCAB_SIZE}",
        logits0.len()
    );
    let next = argmax(&logits0[..VOCAB_SIZE]) as i64;

    // Harvest all 16 "present" KV entries (4 layers × {decoder, encoder} × {key, value}).
    let mut present_kv: HashMap<String, Array4<f32>> = HashMap::with_capacity(16);
    for layer in 0..NUM_DECODER_LAYERS {
        for place in ["decoder", "encoder"] {
            for kv in ["key", "value"] {
                let name = format!("present.{layer}.{place}.{kv}");
                let (shape, data) = step0[name.as_str()].try_extract_tensor::<f32>()?;
                let sv: Vec<usize> = shape.iter().map(|&x| x as usize).collect();
                let arr =
                    Array4::<f32>::from_shape_vec((sv[0], sv[1], sv[2], sv[3]), data.to_vec())?;
                present_kv.insert(name, arr);
            }
        }
    }

    if next == EOS {
        return Ok(String::new());
    }
    let mut output_ids: Vec<i64> = vec![next];

    // --- Decoder_with_past loop (steps 1..N) ---
    for _ in 1..MAX_DECODE_STEPS {
        let last = *output_ids.last().unwrap();
        let step_ids = Array2::<i64>::from_shape_vec((1, 1), vec![last])?;

        let mut inputs = ort::inputs![
            "input_ids" => Value::from_array(step_ids)?,
            "encoder_attention_mask" => Value::from_array(Array2::<i64>::ones((1, n_in)))?,
        ];
        for layer in 0..NUM_DECODER_LAYERS {
            for place in ["decoder", "encoder"] {
                for kv in ["key", "value"] {
                    let present_name = format!("present.{layer}.{place}.{kv}");
                    let past_name = format!("past_key_values.{layer}.{place}.{kv}");
                    let arr = present_kv
                        .get(&present_name)
                        .expect("present KV missing — step 0 must have populated all 16 entries")
                        .clone();
                    inputs.push((past_name.into(), Value::from_array(arr)?.into()));
                }
            }
        }

        let out = sess.decoder_with_past.run(inputs)?;

        let (_, logits) = out["logits"].try_extract_tensor::<f32>()?;
        anyhow::ensure!(
            logits.len() >= VOCAB_SIZE,
            "g2p decoder logits too small: got {}, need {VOCAB_SIZE}",
            logits.len()
        );
        let next = argmax(&logits[..VOCAB_SIZE]) as i64;
        if next == EOS {
            break;
        }
        output_ids.push(next);

        // decoder_with_past only emits *decoder*-side presents; encoder KV
        // stays constant across steps, so we leave those entries untouched.
        for layer in 0..NUM_DECODER_LAYERS {
            for kv in ["key", "value"] {
                let present_name = format!("present.{layer}.decoder.{kv}");
                let (shape, data) = out[present_name.as_str()].try_extract_tensor::<f32>()?;
                let sv: Vec<usize> = shape.iter().map(|&x| x as usize).collect();
                let arr =
                    Array4::<f32>::from_shape_vec((sv[0], sv[1], sv[2], sv[3]), data.to_vec())?;
                present_kv.insert(present_name, arr);
            }
        }
    }

    Ok(detokenize(&output_ids))
}

/// Convert text to IPA phonemes for the given espeak-style language code.
/// Words are split on whitespace; punctuation is stripped per-word. Empty
/// input returns an empty string.
pub fn text_to_ipa(text: &str, lang: &str) -> Result<String> {
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    let charsiu = charsiu_lang(lang)?;
    let mut sess = G2pSessions::load()?;
    let mut out: Vec<String> = Vec::new();
    for raw_word in text.split_whitespace() {
        let word: String = raw_word
            .chars()
            .filter(|c| c.is_alphanumeric() || c == &'\'' || c == &'-')
            .collect();
        if word.is_empty() {
            continue;
        }
        let ipa = g2p_word(&mut sess, charsiu, &word)?;
        if !ipa.is_empty() {
            out.push(ipa);
        }
    }
    Ok(out.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_adds_byte_offset_and_eos() {
        let ids = tokenize("eng-us", "hi");
        // '<' 'e' 'n' 'g' '-' 'u' 's' '>' ':' ' ' 'h' 'i' + EOS
        assert_eq!(ids.len(), 13);
        assert_eq!(*ids.last().unwrap(), EOS);
        assert_eq!(ids[0], b'<' as i64 + BYTE_OFFSET);
    }

    #[test]
    fn detokenize_drops_specials() {
        // EOS + PAD + byte('h') + byte('i') → "hi"
        let ids = vec![
            EOS,
            PAD,
            b'h' as i64 + BYTE_OFFSET,
            b'i' as i64 + BYTE_OFFSET,
        ];
        assert_eq!(detokenize(&ids), "hi");
    }

    #[test]
    fn detokenize_round_trips_utf8_ipa() {
        let ipa = "hɛloʊ";
        let ids: Vec<i64> = ipa.bytes().map(|b| b as i64 + BYTE_OFFSET).collect();
        assert_eq!(detokenize(&ids), ipa);
    }

    #[test]
    fn charsiu_lang_accepts_common_codes() {
        assert_eq!(charsiu_lang("en-us").unwrap(), "eng-us");
        assert_eq!(charsiu_lang("ru").unwrap(), "rus");
        assert_eq!(charsiu_lang("FR-FR").unwrap(), "fra");
        assert!(charsiu_lang("xx-XX").is_err());
    }

    #[test]
    fn empty_text_returns_empty() {
        assert_eq!(text_to_ipa("", "en-us").unwrap(), "");
        assert_eq!(text_to_ipa("   ", "en-us").unwrap(), "");
    }

    #[test]
    fn unsupported_lang_errors() {
        let err = text_to_ipa("hi", "xx-XX").unwrap_err();
        assert!(err.to_string().to_lowercase().contains("xx-xx"));
    }

    /// Gated on the presence of the G2P model cache. Run `kesha install --tts`
    /// first. Verifies byte-identical IPA against the spike's reference fixtures
    /// (see docs/superpowers/specs/2026-04-22-onnx-g2p-spike.md section 5).
    #[test]
    fn hello_world_matches_reference_when_model_available() {
        let dir = models::cache_dir()
            .join("models")
            .join("g2p")
            .join("byt5-tiny");
        if !dir.exists() {
            eprintln!("g2p model not cached at {} — skipping", dir.display());
            return;
        }
        let ipa = text_to_ipa("hello", "en-us").unwrap();
        assert_eq!(ipa, "ˈhɛɫoʊ", "expected spike-reference IPA for 'hello'");
        let ipa = text_to_ipa("world", "en-us").unwrap();
        assert_eq!(ipa, "ˈwɝɫd");
    }

    #[test]
    fn multiword_input_produces_space_joined_ipa() {
        let dir = models::cache_dir()
            .join("models")
            .join("g2p")
            .join("byt5-tiny");
        if !dir.exists() {
            return;
        }
        let ipa = text_to_ipa("hello world", "en-us").unwrap();
        assert!(ipa.contains(' '), "expected space between words: {ipa}");
        assert!(ipa.starts_with("ˈh"), "starts with hello: {ipa}");
    }
}
