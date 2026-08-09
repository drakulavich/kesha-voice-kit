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
    /// (`tokens = [[0, *tokens, 0]]`). Earlier versions padded to 512 with
    /// trailing zeros, which the model interpreted as additional silence/noise
    /// tokens — see #207.
    ///
    /// The clamp to [`KOKORO_MAX_ACTIVE`] is a backstop: callers split long
    /// input with [`chunk_ipa`] first, so nothing reaches it in practice (#715).
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

/// Pause punctuation that marks a natural break point, mirroring FluidAudio's
/// `PhonemeChunker.defaultBoundaryPunctuation` so the ONNX and ANE Kokoro paths
/// split long input at the same places.
const BOUNDARY_PUNCTUATION: [char; 8] = [',', '.', ';', ':', '!', '?', '…', '—'];

/// Split an IPA string into chunks that each fit Kokoro's active-token cap.
///
/// Each break is taken at the latest whitespace or pause-punctuation boundary
/// inside the `max_len` window, so words stay intact and punctuation stays with
/// the preceding chunk; a boundary-less run is hard-split at the cap. Chunks are
/// whitespace-trimmed and never empty. Input that already fits is returned
/// verbatim, so short input synthesizes byte-for-byte as it did before #715.
///
/// `max_len` counts characters: [`Tokenizer::encode`] drops what the vocab does
/// not cover and so never emits more ids than input characters.
pub fn chunk_ipa(ipa: &str, max_len: usize) -> Vec<String> {
    assert!(max_len > 0, "chunk_ipa: max_len must be positive");
    let chars: Vec<char> = ipa.chars().collect();
    if chars.len() <= max_len {
        return vec![ipa.to_string()];
    }

    let is_boundary = |c: char| c.is_whitespace() || BOUNDARY_PUNCTUATION.contains(&c);
    let skip_whitespace = |from: usize| {
        let mut i = from;
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        i
    };

    let mut chunks = Vec::new();
    let mut start = skip_whitespace(0);
    while chars.len() - start > max_len {
        let window_end = start + max_len;
        let break_at = (start + 1..window_end)
            .rev()
            .find(|&i| is_boundary(chars[i]))
            .map_or(window_end, |i| i + 1);
        push_trimmed(&chars[start..break_at], &mut chunks);
        start = skip_whitespace(break_at);
    }
    if start < chars.len() {
        push_trimmed(&chars[start..], &mut chunks);
    }
    chunks
}

fn push_trimmed(slice: &[char], chunks: &mut Vec<String>) {
    let text: String = slice.iter().collect();
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        chunks.push(trimmed.to_string());
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
    fn chunk_returns_short_input_verbatim() {
        assert_eq!(chunk_ipa(" həlˈoʊ ", 510), vec![" həlˈoʊ "]);
        assert_eq!(chunk_ipa("", 510), vec![""]);
    }

    #[test]
    fn chunk_breaks_at_latest_whitespace_in_window() {
        assert_eq!(chunk_ipa("aaa bbb ccc ddd", 8), vec!["aaa bbb", "ccc ddd"]);
    }

    #[test]
    fn chunk_keeps_punctuation_with_preceding_chunk() {
        assert_eq!(chunk_ipa("aaaa,bbb", 6), vec!["aaaa,", "bbb"]);
    }

    #[test]
    fn chunk_hard_splits_a_boundary_less_run() {
        assert_eq!(chunk_ipa("aaaaaaaaa", 4), vec!["aaaa", "aaaa", "a"]);
    }

    #[test]
    fn chunk_preserves_every_phoneme() {
        let ipa = (0..300)
            .map(|i| format!("wɜrd{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let chunks = chunk_ipa(&ipa, KOKORO_MAX_ACTIVE);
        assert!(chunks.len() > 1, "expected a split, got {}", chunks.len());
        for c in &chunks {
            assert!(
                c.chars().count() <= KOKORO_MAX_ACTIVE,
                "chunk over cap: {} chars",
                c.chars().count()
            );
        }
        let joined: String = chunks.join(" ");
        assert_eq!(joined, ipa, "chunking dropped or reordered phonemes");
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
