//! Kokoro phoneme → token ID vocabulary. The vocab is embedded at compile time
//! from `hexgrad/Kokoro-82M/config.json` and is stable across Kokoro v1.0 checkpoints.

use std::collections::HashMap;

const VOCAB_JSON: &str = include_str!("../../fixtures/tts/kokoro_vocab.json");

/// Kokoro's max context length. Input tensor is padded to this size.
pub const KOKORO_MAX_TOKENS: usize = 512;
/// Max *active* tokens — we reserve room for a leading+trailing 0 pad.
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

    /// Pad to Kokoro's 512-token context with leading+trailing 0 tokens.
    /// Truncates anything beyond [`KOKORO_MAX_ACTIVE`] silently.
    pub fn pad_to_context(mut ids: Vec<i64>) -> Vec<i64> {
        if ids.len() > KOKORO_MAX_ACTIVE {
            ids.truncate(KOKORO_MAX_ACTIVE);
        }
        let mut out = Vec::with_capacity(KOKORO_MAX_TOKENS);
        out.push(0);
        out.extend(ids);
        out.push(0);
        while out.len() < KOKORO_MAX_TOKENS {
            out.push(0);
        }
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
    fn pads_short_to_context() {
        let padded = Tokenizer::pad_to_context(vec![1, 2, 3]);
        assert_eq!(padded.len(), KOKORO_MAX_TOKENS);
        assert_eq!(&padded[..5], &[0, 1, 2, 3, 0]);
    }

    #[test]
    fn truncates_long_to_context() {
        let ids: Vec<i64> = (1..=600).collect();
        let padded = Tokenizer::pad_to_context(ids);
        assert_eq!(padded.len(), KOKORO_MAX_TOKENS);
        // Still has leading 0
        assert_eq!(padded[0], 0);
        // Trailing pad 0 is at index 511 (last char of vocab is truncated to fit)
        assert_eq!(padded[KOKORO_MAX_TOKENS - 1], 0);
    }
}
