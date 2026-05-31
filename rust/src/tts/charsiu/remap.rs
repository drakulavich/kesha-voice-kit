//! CharsiuG2P → Kokoro-vocab IPA remap. Ported from the spike (PR #507).
//! CharsiuG2P emits a few symbols Kokoro's vocab lacks; map them to the
//! in-vocab equivalents. Locked by a zero-residual-OOV regression test.

/// Remap CharsiuG2P IPA into Kokoro's phoneme inventory.
pub fn remap(ipa: &str) -> String {
    ipa.replace("t͡s", "ʦ")
        .replace("t͡ʃ", "ʧ")
        .replace("d͡ʒ", "ʤ")
        .replace('\u{0067}', "\u{0261}") // Latin g -> script ɡ
        .replace('õ', "o\u{0303}")
        .replace('ũ', "u\u{0303}")
        .replace('ẽ', "e\u{0303}")
        .replace('\u{0361}', "") // drop any residual standalone tie bar
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_tie_bar_affricates() {
        assert_eq!(remap("a t͡s b"), "a ʦ b");
        assert_eq!(remap("d͡ʒusto"), "ʤusto");
        assert_eq!(remap("t͡ʃiko"), "ʧiko");
    }

    #[test]
    fn normalizes_latin_g_to_script_g() {
        assert_eq!(remap("gato"), "ɡato"); // U+0067 -> U+0261
    }

    #[test]
    fn decomposes_precomposed_nasals_to_nfd() {
        assert_eq!(remap("õ"), "o\u{0303}");
        assert_eq!(remap("ũ"), "u\u{0303}");
        assert_eq!(remap("ẽ"), "e\u{0303}");
    }

    #[test]
    fn remapped_output_has_zero_oov_vs_kokoro_vocab() {
        let vocab = crate::tts::tokenizer::Tokenizer::load().unwrap();
        for s in ["t͡salat͡so", "d͡ʒusto", "gato", "kõsiderasõw", "t͡ʃiko"] {
            let mapped = remap(s);
            let nonspace = mapped.chars().filter(|c| !c.is_whitespace()).count();
            assert_eq!(
                vocab.encode(&mapped).len(),
                nonspace,
                "OOV leaked for {s:?} -> {mapped:?}"
            );
        }
    }
}
