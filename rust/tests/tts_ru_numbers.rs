//! Russian number verbalization on the Vosk path (#891).
//!
//! Pure text-in / text-out, so no model gate: these run in every lane.
//! The contract under test is what a listener can observe — every digit is
//! spoken, and the date/time/year forms the corpus sentence exercises come out
//! in the case a Russian speaker would use.

#![cfg(feature = "tts")]

use kesha_engine::tts::ru::normalize_segments;
use kesha_engine::tts::ssml::Segment;

fn normalize(text: &str) -> String {
    match normalize_segments(vec![Segment::Text(text.to_string())], false).as_slice() {
        [Segment::Text(t)] => t.clone(),
        other => panic!("expected a single Text segment, got {other:?}"),
    }
}

#[test]
fn corpus_sentence_speaks_every_number() {
    let out = normalize("Встреча назначена на 25 декабря 2026 года, в 14:30, кабинет 405.");
    assert_eq!(
        out,
        "Встреча назначена на двадцать пятого декабря две тысячи двадцать шестого года, \
         в четырнадцать тридцать, кабинет четыреста пять."
    );
}

#[test]
fn no_digit_ever_reaches_the_synthesizer() {
    // The property behind #891: whatever the shape of the input, Vosk must not
    // be handed a raw digit, because its G2P drops them without a sound.
    for input in [
        "Кабинет 405.",
        "В 2026 году",
        "с 10-15 человек",
        "дом №7",
        "3,5 километра",
        "телефон 89161234567",
        "0,00",
        "007",
    ] {
        let out = normalize(input);
        assert!(
            !out.chars().any(|c| c.is_ascii_digit()),
            "digit survived normalization: {input:?} -> {out:?}"
        );
    }
}
