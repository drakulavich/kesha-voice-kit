//! Grapheme-to-phoneme dispatch.
//!
//! Post #211: English uses our G2P (misaki-rs embedded lexicon + POS).
//! Russian routes through Vosk's internal G2P inside `tts::vosk`.
//! Romance languages (es/fr/it/pt) route through CharsiuG2P (ONNX ByT5-tiny)
//! after text normalisation (#212).

use anyhow::Result;

/// Convert `text` to IPA for the given espeak-style language code.
///
/// - `en`/`en-us`/`en-gb`/`en-uk` → misaki-rs
/// - `es`/`fr`/`it`/`pt` → normalize → CharsiuG2P (byt5-tiny ONNX) via the
///   caller's [`CharsiuCache`], so long-lived callers (`--stdin-loop`) don't
///   reload the ~100 MB ByT5 sessions per request (#509); one-shot callers
///   pass a fresh `CharsiuCache::default()`
/// - `ru` and others → error with a pointer to the engine-specific G2P
pub fn text_to_ipa_cached(
    charsiu: &mut crate::tts::sessions::CharsiuCache,
    text: &str,
    lang: &str,
) -> Result<String> {
    let text_chars = text.chars().count();
    if text.trim().is_empty() {
        crate::dtrace!("g2p::route lang={lang} backend=empty text_chars={text_chars}");
        return Ok(String::new());
    }
    let lower = lang.to_ascii_lowercase();

    let base = crate::tts::charsiu::base_lang(&lower);
    if matches!(base, "es" | "fr" | "it" | "pt") {
        crate::dtrace!("g2p::route lang={lang} backend=charsiu text_chars={text_chars}");
        let dir = crate::models::cache_dir()?.join("models/g2p/byt5-tiny");
        check_charsiu_files(&dir)?;
        let ipa = charsiu.to_ipa(&dir, text, &lower)?;
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
    // #275 D6: one boundary trace so downstream "empty after G2P" failures carry routing context.
    crate::dtrace!("g2p::route lang={lang} backend=misaki text_chars={text_chars}");
    let ipa = misaki_to_ipa(text, misaki_lang)?;
    crate::dtrace!("g2p::result ipa_chars={}", ipa.chars().count());
    Ok(ipa)
}

/// Check that the three required Charsiu ONNX files exist in `dir`; bare `--tts` installs English only, so the hint names a language.
pub(crate) fn check_charsiu_files(dir: &std::path::Path) -> Result<()> {
    let required = [
        "encoder_model.onnx",
        "decoder_model.onnx",
        "decoder_with_past_model.onnx",
    ];
    for file in &required {
        let path = dir.join(file);
        match path.try_exists() {
            Ok(true) => {}
            Ok(false) => crate::coded_bail!(
                crate::errors::ErrorCode::ModelMissing,
                "G2P model for es/fr/it/pt voices not installed at {}. \
                 Run `kesha install --tts es` (or fr, it, pt) to download it.",
                dir.display()
            ),
            Err(err) => crate::coded_bail!(
                crate::errors::ErrorCode::ModelLoad,
                "G2P model {} could not be read ({err}); check its permissions, \
                 or reinstall it: kesha install --tts es (or fr, it, pt)",
                path.display()
            ),
        }
    }
    Ok(())
}

/// Shared by `text_to_ipa_cached` and `CharsiuCache::to_ipa`.
pub(crate) fn charsiu_ipa(
    g: &mut crate::tts::charsiu::Charsiu,
    text: &str,
    lang: &str,
) -> Result<String> {
    let base = crate::tts::charsiu::base_lang(lang);
    let normalized = crate::tts::normalize::normalize(text, base);
    g.to_ipa(&normalized, lang)
}

/// `G2P::new` parses ~20 MB of embedded JSON (~200 ms), so build it once per dialect per process.
fn misaki_g2p(lang: misaki_rs::Language) -> &'static misaki_rs::G2P {
    use misaki_rs::{Language, G2P};
    use std::sync::LazyLock;
    static US: LazyLock<G2P> = LazyLock::new(|| G2P::new(Language::EnglishUS));
    static GB: LazyLock<G2P> = LazyLock::new(|| G2P::new(Language::EnglishGB));
    match lang {
        Language::EnglishUS => &US,
        Language::EnglishGB => &GB,
    }
}

/// Run misaki-rs and strip the U+200D zero-width joiners it inserts for
/// diphthong cohesion — Kokoro/Piper vocabs don't include them. Errors from
/// the embedded G2P (e.g. corrupted lexicon, internal panic surfaced via
/// poisoned mutex) propagate so callers don't synthesize silent audio
/// indistinguishable from an empty utterance.
fn misaki_to_ipa(text: &str, lang: misaki_rs::Language) -> Result<String> {
    let g2p = misaki_g2p(lang);
    let (_, tokens) = g2p
        .g2p(text)
        .map_err(|e| anyhow::anyhow!("misaki-rs g2p failed: {e:?}"))?;
    let (source, _) = g2p.preprocess_links(text);
    let mut ipa = String::new();
    let mut cursor = 0;
    for tk in &tokens {
        let at = source[cursor..].find(&tk.text).map(|i| cursor + i);
        if let Some(at) = at {
            cursor = at + tk.text.len();
            if tk.text == "." && is_abbreviation_period(&source, at) {
                continue;
            }
        }
        ipa.push_str(tk.phonemes.as_deref().unwrap_or(&g2p.unk));
        ipa.push_str(&tk.whitespace);
    }
    Ok(ipa
        .chars()
        .filter(|c| *c != '\u{200d}')
        .collect::<String>()
        .trim()
        .to_string())
}

/// misaki-rs 0.6 turns every `.` into a sentence pause, including `Mr.` and `p.m.` (#1276).
fn is_abbreviation_period(text: &str, at: usize) -> bool {
    const TITLES: &[&str] = &[
        "mr", "mrs", "ms", "dr", "prof", "st", "mt", "rev", "gen", "capt",
    ];
    const SHORT_FORMS: &[&str] = &["etc", "vs", "approx", "inc", "ltd", "co", "corp", "no"];
    let after = &text[at + 1..];
    if after.starts_with(|c: char| c.is_alphabetic()) {
        return true;
    }
    let Some(next) = after.trim_start().chars().next() else {
        return false;
    };
    let before = &text[..at];
    let word_start = before.trim_end_matches(char::is_alphabetic).len();
    let word = before[word_start..].to_ascii_lowercase();
    if TITLES.contains(&word.as_str()) {
        return true;
    }
    let in_initialism = word.chars().count() == 1 && before[..word_start].ends_with('.');
    (in_initialism || SHORT_FORMS.contains(&word.as_str()))
        && (next.is_lowercase() || next.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_to_ipa(text: &str, lang: &str) -> Result<String> {
        text_to_ipa_cached(
            &mut crate::tts::sessions::CharsiuCache::default(),
            text,
            lang,
        )
    }

    #[test]
    fn empty_text_returns_empty() {
        assert_eq!(text_to_ipa("", "en-us").unwrap(), "");
        assert_eq!(text_to_ipa("   ", "en-us").unwrap(), "");
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

    #[test]
    fn castilian_region_routes_to_charsiu() {
        match text_to_ipa("cielo", "es-ES") {
            Ok(ipa) => assert!(!ipa.is_empty(), "es-ES: empty IPA"),
            Err(e) => {
                let m = e.to_string();
                assert!(
                    m.contains("install") || m.contains("G2P"),
                    "es-ES unexpected: {m}"
                );
                assert!(
                    !m.contains("not supported in this build"),
                    "es-ES bailed to #212: {m}"
                );
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
        // Letter-spelling expands to one stressed chunk per letter (≥10 for "Kubernetes").
        let chunks = ipa.split_whitespace().count();
        assert!(
            chunks >= 5,
            "expected letter-spell (≥5 stress-marked chunks) for OOV, got {chunks}: {ipa:?}"
        );
        // ZWJ stripping is a pipeline-owned property, not a misaki one.
        assert!(!ipa.contains('\u{200d}'), "ZWJ leaked: {ipa:?}");
    }

    #[test]
    fn english_abbreviation_periods_do_not_pause_mid_sentence() {
        for (text, want) in [
            (
                "Mr. Smith arrives at 5 p.m. on Monday.",
                "mˈɪstəɹ smˈɪθ ɚɹˈaɪvz æɾ fˈaɪv  pˈiː ˈɛm ˌɔn mˈʌndˌA .",
            ),
            (
                "Dr. Jones met Mrs. Lee in May, and they talked for hours.",
                "dˈɑktəɹ dʒˈoʊnz mˈɛt mˈɪsɪz lˈiː ɪn mˈA , ænd ðeɪ tˈɔːkt fɔːɹ ˈaʊɚz .",
            ),
            (
                "Hello there. How are you today? I'm fine, thanks.",
                "həlˈoʊ ðɛɹ . hˌaʊ ɑːɹ juː tədˈeɪ ? ˌIm fˈaɪn , θˈæŋks .",
            ),
            ("He arrives at 5 p.m.", "hˌiː ɚɹˈaɪvz æɾ fˈaɪv  pˈiː ˈɛm ."),
            (
                "We left at 5 p.m. Then it rained.",
                "wˌiː lˈɛft æɾ fˈaɪv  pˈiː ˈɛm . ðˈɛn ɪɾ ɹˈeɪnd .",
            ),
            ("She met Dr.", "ʃˌiː mˈɛt dˈɑktəɹ ."),
            ("[Hi](/hə.t/). Go.", "hə.t . ɡˌoʊ ."),
        ] {
            assert_eq!(text_to_ipa(text, "en-us").unwrap(), want, "{text}");
        }
    }

    #[test]
    fn english_ipa_is_stable_across_repeated_and_interleaved_dialects() {
        let text = "I say tomato. The schedule for Tuesday is ready.";
        let us = "ˌI sˈeɪ təmˈeɪɾoʊ . ðə skˈɛdʒuːl fɔːɹ tˈuzdˌA ɪz ɹˈɛdi .";
        let gb = "ˌI sˈeɪ təmˈɑːtəʊ . ðə ʃˈɛdjuːl fɔː tjˈuːzdA ɪz ɹˈɛdi .";
        for (lang, want) in [("en-us", us), ("en-gb", gb), ("en", us), ("en-uk", gb)] {
            assert_eq!(text_to_ipa(text, lang).unwrap(), want, "{lang}");
        }
    }
}
