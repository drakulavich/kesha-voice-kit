//! Kokoro phoneme → token ID vocabulary. The vocab is embedded at compile time
//! from `hexgrad/Kokoro-82M/config.json` and is stable across Kokoro v1.0 checkpoints.

use std::collections::HashMap;

const VOCAB_JSON: &str = include_str!("../../fixtures/tts/kokoro_vocab.json");

/// Max *active* tokens — Kokoro's published context length is 512; we wrap
/// with a leading+trailing 0, leaving 510 for actual phoneme IDs.
pub const KOKORO_MAX_ACTIVE: usize = 510;

pub struct Tokenizer {
    map: HashMap<String, i64>,
}

impl Tokenizer {
    pub fn load() -> anyhow::Result<Self> {
        let map: HashMap<String, i64> = serde_json::from_str(VOCAB_JSON)?;
        Ok(Self { map })
    }

    /// Encode an IPA string into Kokoro token IDs.
    /// Unknown characters are dropped silently (matches upstream misaki behavior).
    pub fn encode(&self, ipa: &str) -> Vec<i64> {
        ipa.chars()
            .filter_map(|c| {
                let s = c.to_string();
                self.map.get(&s).copied()
            })
            .collect()
    }

    /// Wrap with a single leading+trailing 0 — matches `kokoro-onnx` upstream
    /// (`tokens = [[0, *tokens, 0]]`). Truncates beyond [`KOKORO_MAX_ACTIVE`]
    /// silently. Earlier versions padded to 512 with trailing zeros, which the
    /// model interpreted as additional silence/noise tokens — see #207.
    pub fn pad_to_context(mut ids: Vec<i64>) -> Vec<i64> {
        if ids.len() > KOKORO_MAX_ACTIVE {
            ids.truncate(KOKORO_MAX_ACTIVE);
        }
        let mut out = Vec::with_capacity(ids.len() + 2);
        out.push(0);
        out.extend(ids);
        out.push(0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocab_loads_with_enough_entries() {
        let t = Tokenizer::load().unwrap();
        assert!(t.map.len() > 50, "vocab too small: {} entries", t.map.len());
    }

    #[test]
    fn encodes_space_phoneme() {
        let t = Tokenizer::load().unwrap();
        let ids = t.encode(" ");
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn drops_unknown_characters() {
        let t = Tokenizer::load().unwrap();
        // Private-use-area character — guaranteed not in vocab.
        let ids = t.encode("\u{E000}");
        assert!(ids.is_empty());
    }

    #[test]
    fn encodes_real_ipa_string() {
        let t = Tokenizer::load().unwrap();
        let ids = t.encode("həlˈoʊ");
        assert_eq!(ids.len(), "həlˈoʊ".chars().count(), "ids={ids:?}");
    }

    #[test]
    fn wraps_with_leading_and_trailing_zero() {
        let padded = Tokenizer::pad_to_context(vec![1, 2, 3]);
        assert_eq!(padded, vec![0, 1, 2, 3, 0]);
    }

    #[test]
    fn truncates_beyond_max_active() {
        let ids: Vec<i64> = (1..=600).collect();
        let padded = Tokenizer::pad_to_context(ids);
        assert_eq!(padded.len(), KOKORO_MAX_ACTIVE + 2);
        assert_eq!(padded[0], 0);
        assert_eq!(padded[padded.len() - 1], 0);
    }
}
