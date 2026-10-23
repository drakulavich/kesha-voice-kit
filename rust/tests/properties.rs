//! Property tests for invariants the example tests only sample (#1479); nightly reruns them with a random `PROPTEST_RNG_SEED`.

#![cfg(feature = "tts")]

use kesha_engine::tts::ru::normalize_segments;
use kesha_engine::tts::ssml::{parse, Segment};
use kesha_engine::tts::tokenizer::chunk_ipa;
use proptest::prelude::*;
use proptest::test_runner::RngSeed;

fn config() -> ProptestConfig {
    let mut config = ProptestConfig {
        failure_persistence: None,
        ..ProptestConfig::default()
    };
    if std::env::var_os("PROPTEST_RNG_SEED").is_none() {
        config.rng_seed = RngSeed::Fixed(1479);
    }
    config
}

fn non_whitespace(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn no_digit_ever_reaches_the_synthesizer(input in "[0-9а-яА-Я ,.:;№%+/-]{0,40}") {
        let out = normalize_segments(vec![Segment::Text(input.clone())], false);
        for seg in &out {
            if let Segment::Text(t) = seg {
                prop_assert!(!t.chars().any(|c| c.is_ascii_digit()), "{input:?} -> {t:?}");
            }
        }
    }

    #[test]
    fn chunking_keeps_every_phoneme_under_the_cap(
        ipa in "[a-zɜəˈː ,.!?;:]{0,1200}",
        max_len in 1usize..600,
    ) {
        let chunks = chunk_ipa(&ipa, max_len);
        for c in &chunks {
            prop_assert!(c.chars().count() <= max_len, "chunk over {max_len}: {c:?}");
        }
        prop_assert_eq!(non_whitespace(&chunks.concat()), non_whitespace(&ipa));
    }

    #[test]
    fn ssml_parse_never_panics(
        input in "(<speak>|</speak>|<break time=\"[0-9]{1,5}(ms|s)\"/>|<emphasis>|</emphasis>|<say-as interpret-as=\"characters\">|</say-as>|[a-zа-я0-9 &;<>\"'/=!-]){0,40}",
    ) {
        let _ = parse(&input);
    }

    #[test]
    fn escaped_text_inside_speak_comes_back_whole(text in "[a-zA-Zа-яА-Я0-9 ,.!?&<>\"']{1,80}") {
        prop_assume!(!text.trim().is_empty());
        let segs = parse(&format!("<speak>{}</speak>", xml_escape(&text)))
            .map_err(|e| TestCaseError::fail(format!("{text:?}: {e}")))?;
        let spoken: String = segs
            .iter()
            .filter_map(|s| match s {
                Segment::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        prop_assert_eq!(non_whitespace(&spoken), non_whitespace(&text));
    }
}
