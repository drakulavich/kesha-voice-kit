//! Parity harness: detect drift in misaki-rs G2P output.
//!
//! Post-#213: only English entries remain. CharsiuG2P (ONNX ByT5-tiny) and
//! espeak-ng were both removed in PR #213; Russian and other languages route
//! through engine-internal G2P (vosk-tts for Russian, #212 for others).
//!
//! This corpus is frozen against misaki-rs at the crate version pinned in
//! Cargo.lock. Drift detection still serves: a misaki-rs version bump or an
//! embedded-lexicon change would produce different IPA without tripping any
//! SHA-256 check. If a drift change is intentional (e.g. misaki-rs version
//! bump), regenerate by running the test with `REGENERATE_G2P_REFERENCE=1`
//! and pasting the printed tuples back into this file.
//!
//! misaki-rs is embedded — no model cache required; the test always runs.

#![cfg(feature = "tts")]

use kesha_engine::tts::g2p::text_to_ipa;

/// Frozen reference. `(espeak-style lang code, input word, expected IPA)`.
/// English (American + British) — misaki-rs lexicon + POS, no system deps.
const REFERENCE: &[(&str, &str, &str)] = &[
    // English (American) — misaki-rs lexicon + espeak fallback for OOV.
    ("en-us", "hello", "həlˈoʊ"),
    ("en-us", "world", "wˈɜːld"),
    ("en-us", "cat", "kˈæt"),
    ("en-us", "dog", "dˈɑːɡ"),
    ("en-us", "phone", "fˈoʊn"),
    ("en-us", "music", "mjˈuːzɪk"),
    ("en-us", "code", "kˈoʊd"),
    ("en-us", "review", "ɹᵻvjˈuː"),
    ("en-us", "deploy", "dᵻplˈɔɪ"),
    ("en-us", "test", "tˈɛst"),
    // English (British) — misaki-rs en-gb dialect.
    ("en-gb", "colour", "kˈʌlə"),
    ("en-gb", "theatre", "θˈiətə"),
    ("en-gb", "metre", "mˈiːtə"),
    ("en-gb", "harbour", "hˈɑːbə"),
];

#[test]
fn g2p_output_matches_frozen_reference() {
    // SAFETY VALVE: `REGENERATE_G2P_REFERENCE=1` is a maintainer escape hatch.
    // If it gets left exported in a shell profile, this test becomes a silent
    // no-op forever and real drift lands unnoticed. Loud stderr banner below;
    // CI must never set this env var.
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
        eprintln!(
            "\n\x1b[33m=============================================================\n\
             REGENERATE_G2P_REFERENCE=1 → drift check DISABLED for this run.\n\
             Paste the tuples below back into REFERENCE, then unset the env var.\n\
             =============================================================\x1b[0m\n"
        );
        for line in regen_lines {
            eprintln!("{line}");
        }
        return;
    }

    assert!(
        mismatches.is_empty(),
        "G2P output drifted from frozen reference ({} of {} entries). If this was \
         intentional (e.g. misaki-rs version bump), regenerate via \
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
    assert!(REFERENCE.len() >= 14, "corpus shrunk below expected size");
    for &(lang, word, expected) in REFERENCE {
        assert!(!expected.is_empty(), "empty ref for {lang}/{word}");
    }
    // Coverage: at least 2 distinct language codes present (en-us + en-gb).
    let langs: std::collections::HashSet<&str> = REFERENCE.iter().map(|e| e.0).collect();
    assert!(
        langs.len() >= 2,
        "corpus covers only {} languages, want ≥ 2",
        langs.len()
    );
}
