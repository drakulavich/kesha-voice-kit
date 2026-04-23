//! Parity harness: detect drift in G2P output.
//!
//! Pinned hashes guard the ONNX weight bytes, but the tokenization /
//! decode-loop plumbing around them can still drift silently — a
//! tokenizer offset change or an argmax tie-break flip would produce
//! different IPA without tripping the SHA-256 check. This test locks
//! the end-to-end phoneme output for 40 words across 11 languages
//! against a frozen reference captured from the FP32 model at the
//! manifest's current SHAs (see `rust/src/models.rs::g2p_onnx_manifest`).
//!
//! The reference is *not* a quality assertion — some entries have
//! noisy tails that match the upstream paper's 8.1% PER baseline.
//! If a drift change is intentional (e.g. bumping the model version),
//! regenerate by running the test with `REGENERATE_G2P_REFERENCE=1`
//! and pasting the printed tuples back into this file.
//!
//! Gated on the G2P model being cached under `KESHA_CACHE_DIR`.

#![cfg(feature = "tts")]

use kesha_engine::models;
use kesha_engine::tts::g2p::text_to_ipa;

/// Frozen reference. `(espeak-style lang code, input word, expected IPA)`.
const REFERENCE: &[(&str, &str, &str)] = &[
    // English (American) — in-dict and common engineering vocabulary
    ("en-us", "hello", "ˈhɛɫoʊ"),
    ("en-us", "world", "ˈwɝɫd"),
    ("en-us", "cat", "ˈkætu"),
    ("en-us", "dog", "ˈdɑɡz"),
    ("en-us", "phone", "ˈfoʊniˈoʊ"),
    ("en-us", "music", "ˈmuzɪk"),
    ("en-us", "code", "ˈkoʊdeɪ"),
    ("en-us", "review", "ɹɪvˈju"),
    ("en-us", "deploy", "dɪˈpɫɔɪ"),
    ("en-us", "test", "ˈtɛstoʊ"),
    // English (British) — RP-ish
    ("en-gb", "colour", "kˈʌlə"),
    ("en-gb", "theatre", "tˈiːtɹeɪ"),
    ("en-gb", "metre", "mˈɛtɹeɪ"),
    ("en-gb", "harbour", "hˈɑːbə"),
    // French
    ("fr", "bonjour", "bɔ̃ʒuʁ"),
    ("fr", "merci", "mɛʁsi"),
    ("fr", "oui", "wi"),
    ("fr", "non", "nɔ̃"),
    // German
    ("de", "hallo", "ˈhallo"),
    ("de", "danke", "ˈdaŋke"),
    ("de", "nein", "ˈnaen"),
    ("de", "eins", "ˈaens"),
    // Russian (Cyrillic)
    ("ru", "привет", "prʲɪvʲetə"),
    ("ru", "спасибо", "spɐsʲibə"),
    ("ru", "нет", "nɛtə"),
    ("ru", "мир", "mʲir"),
    // Spanish
    ("es", "hola", "olao"),
    ("es", "gracias", "gɾasjasm"),
    ("es", "adios", "aðjozm"),
    ("es", "gato", "ɣato"),
    // Italian
    ("it", "ciao", "t͡ʃao"),
    ("it", "grazie", "ɡratt͡sjɛ"),
    ("it", "pizza", "pitt͡saɔ"),
    ("it", "casa", "kazaɔ"),
    // Portuguese (Brazilian)
    ("pt-br", "obrigado", "obɾiɡado"),
    ("pt-br", "ola", "olaw"),
    ("pt-br", "adeus", "adewzu"),
    // Japanese (ASCII romaji — HuggingFace's tokenizer byte-encodes non-ASCII
    // lossily in some environments; romaji keeps the test robust across runners)
    ("ja", "konnichiwa", "konɲitʃiwakɯ"),
    // Mandarin (pinyin)
    ("zh", "nihao", "nihau̯"),
    // Hindi (Latin transliteration)
    ("hi", "namaste", "nɒmɒsteː"),
];

fn model_cached() -> bool {
    let dir = models::cache_dir()
        .join("models")
        .join("g2p")
        .join("byt5-tiny");
    [
        "encoder_model.onnx",
        "decoder_model.onnx",
        "decoder_with_past_model.onnx",
    ]
    .iter()
    .all(|f| dir.join(f).exists())
}

#[test]
fn g2p_output_matches_frozen_reference() {
    if !model_cached() {
        eprintln!(
            "g2p model not cached at {}/models/g2p/byt5-tiny — skipping parity harness",
            models::cache_dir().display()
        );
        return;
    }

    let regenerate = std::env::var("REGENERATE_G2P_REFERENCE").is_ok();
    let mut mismatches: Vec<String> = Vec::new();
    let mut regen_lines: Vec<String> = Vec::new();

    for &(lang, word, expected) in REFERENCE {
        let actual = text_to_ipa(word, lang).expect("g2p call failed");
        if regenerate {
            regen_lines.push(format!("    (\"{lang}\", \"{word}\", \"{actual}\"),"));
        } else if actual != expected {
            mismatches.push(format!(
                "  ({lang:>6}) {word:<14} expected {expected:?} got {actual:?}"
            ));
        }
    }

    if regenerate {
        eprintln!("REGENERATE mode — paste these tuples back into REFERENCE:\n");
        for line in regen_lines {
            eprintln!("{line}");
        }
        return;
    }

    assert!(
        mismatches.is_empty(),
        "G2P output drifted from frozen reference ({} of {} entries). If this was \
         intentional (e.g. model version bump), regenerate via \
         `REGENERATE_G2P_REFERENCE=1 cargo test --test g2p_parity`.\n\n{}",
        mismatches.len(),
        REFERENCE.len(),
        mismatches.join("\n"),
    );
}

/// Shape sanity — catches someone accidentally committing empty references
/// or shrinking the corpus below its designed coverage.
#[test]
fn reference_corpus_is_well_formed() {
    assert!(REFERENCE.len() >= 40, "corpus shrunk below expected size");
    for &(lang, word, expected) in REFERENCE {
        assert!(!expected.is_empty(), "empty ref for {lang}/{word}");
    }
    // Coverage: at least 8 distinct language codes present.
    let langs: std::collections::HashSet<&str> = REFERENCE.iter().map(|e| e.0).collect();
    assert!(
        langs.len() >= 8,
        "corpus covers only {} languages, want ≥ 8",
        langs.len()
    );
}
