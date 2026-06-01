//! Grapheme-to-phoneme dispatch.
//!
//! Post #213: English uses our G2P (misaki-rs embedded lexicon + POS).
//! Russian routes through Vosk's internal G2P inside `tts::vosk`.
//! Romance languages (es/fr/it/pt) route through CharsiuG2P (ONNX ByT5-tiny)
//! after text normalisation (#212).

use anyhow::Result;

/// Convert `text` to IPA for the given espeak-style language code.
///
/// - `en`/`en-us`/`en-gb`/`en-uk` → misaki-rs
/// - `es`/`fr`/`it`/`pt` → normalize → CharsiuG2P (byt5-tiny ONNX)
/// - `ru` and others → error with a pointer to the engine-specific G2P
pub fn text_to_ipa(text: &str, lang: &str) -> Result<String> {
    let text_chars = text.chars().count();
    if text.trim().is_empty() {
        crate::dtrace!("g2p::route lang={lang} backend=empty text_chars={text_chars}");
        return Ok(String::new());
    }
    let lower = lang.to_ascii_lowercase();

    // Romance languages: normalize then CharsiuG2P (ONNX ByT5-tiny, #212).
    if matches!(lower.as_str(), "es" | "fr" | "it" | "pt") {
        crate::dtrace!("g2p::route lang={lang} backend=charsiu text_chars={text_chars}");
        let dir = crate::models::cache_dir().join("models/g2p/byt5-tiny");
        check_charsiu_files(&dir)?;
        let mut g = crate::tts::charsiu::Charsiu::load(&dir)?;
        let ipa = charsiu_ipa(&mut g, text, &lower)?;
        crate::dtrace!("g2p::result ipa_chars={}", ipa.chars().count());
        return Ok(ipa);
    }

    let misaki_lang = match lower.as_str() {
        "en" | "en-us" => misaki_rs::Language::EnglishUS,
        "en-gb" | "en-uk" => misaki_rs::Language::EnglishGB,
        other => anyhow::bail!(
            "G2P for '{other}' is not supported in this build. \
             Russian: use a 'ru-vosk-*' voice (G2P happens inside vosk-tts). \
             Other languages: tracked in #212."
        ),
    };
    // #275 D6: log the dispatch branch + char counts so a downstream
    // `"empty after G2P"` bail has the routing context attached. One
    // boundary trace, never per-token.
    crate::dtrace!("g2p::route lang={lang} backend=misaki text_chars={text_chars}");
    let ipa = misaki_to_ipa(text, misaki_lang)?;
    crate::dtrace!("g2p::result ipa_chars={}", ipa.chars().count());
    Ok(ipa)
}

/// Check that the three required Charsiu ONNX files exist in `dir`.
/// Returns a user-facing error pointing at `kesha install --tts` if any are missing.
pub(crate) fn check_charsiu_files(dir: &std::path::Path) -> Result<()> {
    let required = [
        "encoder_model.onnx",
        "decoder_model.onnx",
        "decoder_with_past_model.onnx",
    ];
    for file in &required {
        if !dir.join(file).exists() {
            anyhow::bail!("G2P model not installed. Run `kesha install --tts` to download.");
        }
    }
    Ok(())
}

/// Normalize `text` for `lang` then run CharsiuG2P on the already-loaded session.
/// Shared by the one-shot path (`text_to_ipa`) and the cached loop path
/// (`CharsiuCache::to_ipa`).
pub(crate) fn charsiu_ipa(
    g: &mut crate::tts::charsiu::Charsiu,
    text: &str,
    lang: &str,
) -> Result<String> {
    let normalized = crate::tts::normalize::normalize(text, lang);
    g.to_ipa(&normalized, lang)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_returns_empty() {
        assert_eq!(text_to_ipa("", "en-us").unwrap(), "");
        assert_eq!(text_to_ipa("   ", "en-us").unwrap(), "");
    }

    #[test]
    fn english_routes_to_misaki() {
        let ipa = text_to_ipa("hello", "en-us").unwrap();
        assert!(!ipa.is_empty(), "misaki returned empty IPA");
    }

    #[test]
    fn english_dispatches_for_all_en_aliases() {
        for code in ["en", "en-us", "en-gb", "en-uk"] {
            let ipa = text_to_ipa("hello", code).unwrap();
            assert!(!ipa.is_empty(), "empty IPA for lang code {code}");
        }
    }

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
    fn russian_now_errors_with_vosk_hint() {
        let err = text_to_ipa("привет", "ru").unwrap_err().to_string();
        assert!(err.contains("ru-vosk"), "msg: {err}");
    }

    #[test]
    fn romance_langs_route_to_charsiu_not_212_bail() {
        for lang in ["es", "fr", "it", "pt"] {
            match text_to_ipa("hola", lang) {
                Ok(ipa) => assert!(!ipa.is_empty(), "{lang}: empty IPA"), // model present (dev)
                Err(e) => {
                    // model absent (CI)
                    let m = e.to_string();
                    assert!(
                        m.contains("install") || m.contains("G2P"),
                        "{lang}: unexpected err: {m}"
                    );
                    assert!(
                        !m.contains("not supported in this build") && !m.contains("212"),
                        "{lang}: still bails to #212: {m}"
                    );
                }
            }
        }
    }

    /// Locks the letter-spell fallback behavior we ship in v1.4.x — without
    /// the misaki-rs `espeak` feature, OOV proper nouns expand to per-letter
    /// English names. Documented in `docs/tts.md` so users hitting this
    /// "kesha spells my name" symptom can find the cause.
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
