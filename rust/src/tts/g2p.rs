//! Grapheme-to-phoneme via CharsiuG2P ByT5-tiny ONNX (#123). Three ORT
//! sessions (encoder, decoder, decoder-with-past) plus greedy decoding
//! with explicit KV-cache management. Byte-level tokenizer adds 3 to each
//! UTF-8 byte (PAD=0, EOS=1, UNK=2 reserved). Prompt format is
//! `<{lang}>: {word}` where `{lang}` is a CharsiuG2P code.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use ndarray::{Array2, Array3, Array4};
use ort::session::Session;
use ort::value::Value;

use crate::models;
use crate::util::argmax;

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
        let dir_str = models::g2p_model_dir();
        anyhow::ensure!(
            models::is_g2p_cached(&dir_str),
            "G2P model not installed. Run: kesha install --tts"
        );
        let dir = Path::new(&dir_str);
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
    Session::builder()
        .context("create g2p session builder")?
        .commit_from_file(path)
        .with_context(|| format!("open {}", path.display()))
}

/// Map espeak-style language codes to CharsiuG2P prompt codes. The
/// upstream training corpus uses non-standard suffixes — notably
/// Portuguese is `por-bz` / `por-po` (not `-br`/`-pt`) per the dict
/// filenames at <https://github.com/lingjzhu/CharsiuG2P/tree/main/dicts>.
/// "ISO-looking" substitutions would silently produce garbage since the
/// model has never seen that prompt.
fn charsiu_lang(espeak: &str) -> Result<&'static str> {
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

/// Byte-level tokenization: `<{lang}>: {word}` → UTF-8 bytes + 3, EOS.
fn tokenize(charsiu_code: &str, word: &str) -> Vec<i64> {
    let prompt = format!("<{charsiu_code}>: {word}");
    let mut ids: Vec<i64> = prompt.bytes().map(|b| b as i64 + BYTE_OFFSET).collect();
    ids.push(EOS);
    ids
}

/// Invert the byte+3 encoding. Special tokens (< `BYTE_OFFSET`) drop silently.
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

/// Build all 16 KV name keys: `{prefix}.{layer}.{place}.{kv}`.
fn kv_names(prefix: &str, layer: usize, place: &str, kv: &str) -> String {
    format!("{prefix}.{layer}.{place}.{kv}")
}

/// Convert one word to IPA. Sessions are passed in so the caller can amortize
/// the ~100 ms session-load across all words in the input.
fn g2p_word(sess: &mut G2pSessions, charsiu_code: &str, word: &str) -> Result<String> {
    let input_ids = tokenize(charsiu_code, word);
    let n_in = input_ids.len();

    // --- Encoder ---
    let enc_ids = Array2::<i64>::from_shape_vec((1, n_in), input_ids.clone())?;
    // `Value::from_array` consumes its input, so the attention mask is a
    // fresh all-ones Array2 at each boundary.
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

    // KV is split two ways: encoder-side entries are constants (the model
    // never re-emits them), so we build them once and reuse by reference.
    // Decoder-side entries update every step and are kept in a separate
    // map we clone each iteration.
    let mut encoder_kv: HashMap<String, Array4<f32>> = HashMap::with_capacity(8);
    let mut decoder_kv: HashMap<String, Array4<f32>> = HashMap::with_capacity(8);
    for layer in 0..NUM_DECODER_LAYERS {
        for kv in ["key", "value"] {
            for (place, target) in [("encoder", &mut encoder_kv), ("decoder", &mut decoder_kv)] {
                let name = kv_names("present", layer, place, kv);
                let (shape, data) = step0[name.as_str()].try_extract_tensor::<f32>()?;
                let sv: Vec<usize> = shape.iter().map(|&x| x as usize).collect();
                let arr =
                    Array4::<f32>::from_shape_vec((sv[0], sv[1], sv[2], sv[3]), data.to_vec())?;
                target.insert(name, arr);
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
            for kv in ["key", "value"] {
                for (place, source) in [("encoder", &encoder_kv), ("decoder", &decoder_kv)] {
                    let past_name = kv_names("past_key_values", layer, place, kv);
                    let present_name = kv_names("present", layer, place, kv);
                    let arr = source
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
        // stays constant across steps, so we leave `encoder_kv` alone.
        for layer in 0..NUM_DECODER_LAYERS {
            for kv in ["key", "value"] {
                let present_name = kv_names("present", layer, "decoder", kv);
                let (shape, data) = out[present_name.as_str()].try_extract_tensor::<f32>()?;
                let sv: Vec<usize> = shape.iter().map(|&x| x as usize).collect();
                let arr =
                    Array4::<f32>::from_shape_vec((sv[0], sv[1], sv[2], sv[3]), data.to_vec())?;
                decoder_kv.insert(present_name, arr);
            }
        }
    }

    Ok(detokenize(&output_ids))
}

/// Convert text to IPA phonemes for the given espeak-style language code.
/// English (`en`, `en-us`, `en-gb`) uses misaki-rs (POS-aware, Kokoro-trained
/// inventory + espeak fallback for OOV). Other languages fall through to the
/// CharsiuG2P ONNX path. Empty input returns an empty string.
pub fn text_to_ipa(text: &str, lang: &str) -> Result<String> {
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    if let Some(misaki_lang) = misaki_lang_for(lang) {
        return misaki_to_ipa(text, misaki_lang);
    }
    text_to_ipa_charsiu(text, lang)
}

fn misaki_lang_for(lang: &str) -> Option<misaki_rs::Language> {
    match lang.to_ascii_lowercase().as_str() {
        "en" | "en-us" => Some(misaki_rs::Language::EnglishUS),
        "en-gb" | "en-uk" => Some(misaki_rs::Language::EnglishGB),
        _ => None,
    }
}

/// Run misaki-rs and strip the U+200D zero-width joiners it inserts for
/// diphthong cohesion — Kokoro/Piper vocabs don't include them. Errors from
/// the embedded G2P (e.g. corrupted lexicon, internal panic surfaced via
/// poisoned mutex) propagate so callers don't synthesize silent audio
/// indistinguishable from an empty utterance.
fn misaki_to_ipa(text: &str, lang: misaki_rs::Language) -> Result<String> {
    let g2p = misaki_rs::G2P::new(lang);
    let (ipa, _) = g2p
        .g2p(text)
        .map_err(|e| anyhow::anyhow!("misaki-rs g2p failed: {e:?}"))?;
    Ok(ipa
        .chars()
        .filter(|c| *c != '\u{200d}')
        .collect::<String>()
        .trim()
        .to_string())
}

/// CharsiuG2P fallback for languages misaki-rs doesn't support. Per-word
/// tokenization strips punctuation — see #210 for the Russian-Piper followup
/// that needs punctuation passthrough via espeak-ng.
fn text_to_ipa_charsiu(text: &str, lang: &str) -> Result<String> {
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
        assert_eq!(charsiu_lang("pt-br").unwrap(), "por-bz");
        assert_eq!(charsiu_lang("pt-pt").unwrap(), "por-po");
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

    /// English path uses misaki-rs (self-contained, no cache needed). Verifies
    /// the IPA contains the expected stressed vowels for `hello world`.
    #[test]
    fn english_misaki_produces_expected_phonemes() {
        let ipa = text_to_ipa("hello world", "en-us").unwrap();
        assert!(ipa.contains('h'), "missing /h/ in: {ipa}");
        assert!(ipa.contains('w'), "missing /w/ in: {ipa}");
        assert!(ipa.contains('ˈ'), "missing primary stress in: {ipa}");
        // No zero-width joiner — we strip it before returning.
        assert!(!ipa.contains('\u{200d}'), "ZWJ leaked into IPA: {ipa:?}");
    }

    #[test]
    fn english_dispatches_to_misaki_for_en_aliases() {
        assert!(misaki_lang_for("en").is_some());
        assert!(misaki_lang_for("en-us").is_some());
        assert!(misaki_lang_for("EN-US").is_some());
        assert!(misaki_lang_for("en-gb").is_some());
        assert!(misaki_lang_for("en-uk").is_some());
        assert!(misaki_lang_for("ru").is_none());
    }

    /// Locks the letter-spell fallback behavior we ship in v1.4.x — without
    /// the misaki-rs `espeak` feature, OOV proper nouns expand to per-letter
    /// English names. Documented in `docs/tts.md` so users hitting this
    /// "kesha spells my name" symptom can find the cause. Tracked as the
    /// follow-up under #207 to re-enable the espeak fallback.
    #[test]
    fn english_oov_letter_spells_without_espeak_fallback() {
        let ipa = text_to_ipa("Kubernetes", "en-us").unwrap();
        // A single phonemized word is short; letter-spelling expands to one
        // emphasized chunk per letter (K-U-B-E-R-N-E-T-E-S = 10 chunks).
        let chunks = ipa.split_whitespace().count();
        assert!(
            chunks >= 5,
            "expected letter-spell (≥5 stress-marked chunks) for OOV, got {chunks}: {ipa:?}"
        );
        // ZWJ stripping is a pipeline-owned property, not a misaki one.
        assert!(!ipa.contains('\u{200d}'), "ZWJ leaked: {ipa:?}");
    }
}
