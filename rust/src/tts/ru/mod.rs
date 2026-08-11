//! Russian-specific text normalization for the Vosk-TTS path.
//!
//! Three responsibilities — all pure text-in / text-out:
//! - `letter_table::expand_chars` — letter-by-letter spelling for `<say-as interpret-as="characters">`.
//! - `acronym::expand_acronyms` — auto-detect all-uppercase Cyrillic acronyms in plain text.
//! - `numbers::verbalize` — digits to words, which Vosk's G2P cannot do itself (#891).
//!
//! `normalize_segments` routes [`crate::tts::ssml::Segment`] values through the appropriate primitive.

pub(super) mod acronym;
pub(super) mod letter_table;
pub(super) mod numbers;

use std::borrow::Cow;

use crate::tts::ssml::Segment;

/// Normalize plain text for Vosk: numbers always become words, acronyms are
/// spelled out only when `expand_abbrev` is set. Used by the non-SSML path;
/// the SSML path goes through `normalize_segments` instead so it can also
/// handle `Segment::Spell`.
///
/// Digits are not an abbreviation feature — `--no-expand-abbrev` suppresses
/// letter-spelling, never number verbalization, because raw digits reach
/// Vosk's G2P and are dropped in silence (#891).
pub fn expand_text(text: &str, expand_abbrev: bool) -> String {
    let expanded: Cow<'_, str> = if expand_abbrev {
        Cow::Owned(acronym::expand_acronyms(text))
    } else {
        Cow::Borrowed(text)
    };
    numbers::verbalize(&expanded)
}

/// Normalize a segment list for the Russian Vosk path.
///
/// `ProsodyRate` recurses into its `content` so that `<prosody rate>` does not
/// silently disable acronym expansion, `<say-as characters>`, or `<emphasis>`
/// for nested segments.
///
/// `<say-as interpret-as="characters">` (`Spell`) always wins regardless of
/// `auto_expand` — its content is already extracted into a `Spell` segment by
/// the time we get here.
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter()
        .map(|s| match s {
            Segment::Spell(t) => Segment::Text(letter_table::expand_chars(&t)),
            Segment::Emphasis { content, suppress } => {
                if suppress {
                    let stripped = crate::tts::strip_emphasis_markers(content);
                    Segment::Text(stripped)
                } else {
                    if !content.contains('+') {
                        crate::tts::warn::warn_once(
                            "emphasis-no-plus",
                            "<emphasis> content has no `+` marker; \
                             ru-vosk-* needs `сл+ово` syntax to shift stress \
                             away from the default first-syllable position",
                        );
                    }
                    Segment::Text(content)
                }
            }
            Segment::Text(t) if auto_expand => Segment::Text(acronym::expand_acronyms(&t)),
            Segment::ProsodyRate { rate, content } => Segment::ProsodyRate {
                rate,
                content: normalize_segments(content, auto_expand),
            },
            other => other,
        })
        .map(verbalize_numbers)
        .collect()
}

/// Runs after the per-variant arms so no `Text` escapes with digits in it,
/// whichever arm produced it (#891). `Spell` has already read its digits out
/// one by one via the letter table, so this only ever sees prose numbers.
fn verbalize_numbers(seg: Segment) -> Segment {
    match seg {
        Segment::Text(t) => Segment::Text(numbers::verbalize(&t)),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn plain_text_path_verbalizes_digits() {
        // #891: bare digits reach Vosk's G2P and are silently dropped —
        // `kesha say "Кабинет 405."` speaks "Кабинет".
        assert_eq!(expand_text("Кабинет 405.", true), "Кабинет четыреста пять.");
        assert_eq!(
            expand_text("Кабинет 405.", false),
            "Кабинет четыреста пять."
        );
    }

    #[test]
    fn text_segments_verbalize_digits_even_without_auto_expand() {
        // Number verbalization is not an abbreviation feature: --no-expand-abbrev
        // suppresses acronym spelling, never digits (#891).
        let out = normalize_segments(vec![Segment::Text("Кабинет 405.".to_string())], false);
        assert_eq!(
            out,
            vec![Segment::Text("Кабинет четыреста пять.".to_string())]
        );
    }

    #[test]
    fn spelled_digits_are_not_re_read_as_a_cardinal() {
        // <say-as characters>405</say-as> asked for digit-by-digit; the
        // number pass must find nothing left to do (#891).
        let out = normalize_segments(vec![Segment::Spell("405".to_string())], false);
        assert_eq!(out, vec![Segment::Text("четыре ноль пять".to_string())]);
    }

    #[test]
    fn acronyms_and_numbers_compose_in_one_pass() {
        // The two rewrites read disjoint token shapes, so neither can eat the
        // other's input — but «МФЦ 405» is the case that proves it.
        assert_eq!(expand_text("МФЦ 405", true), "эм эф цэ четыреста пять");
        assert_eq!(expand_text("МФЦ 405", false), "МФЦ четыреста пять");
        // A `+` stress marker is not a digit run and must survive untouched.
        assert_eq!(expand_text("д+ома 405", false), "д+ома четыреста пять");
    }

    #[test]
    fn emphasis_content_is_verbalized_like_any_other_text() {
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "405".to_string(),
                suppress: true,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("четыреста пять".to_string())]);
    }

    #[test]
    fn prosody_rate_recurses_number_verbalization_inside() {
        let out = normalize_segments(
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![Segment::Text("кабинет 405".to_string())],
            }],
            false,
        );
        assert_eq!(
            out,
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![Segment::Text("кабинет четыреста пять".to_string())],
            }]
        );
    }

    #[test]
    fn spell_segment_becomes_text_via_letter_table() {
        let out = normalize_segments(vec![Segment::Spell("ВОЗ".to_string())], false);
        assert_eq!(out, vec![Segment::Text("вэ о зэ".to_string())]);
    }

    #[test]
    fn text_runs_acronym_expansion_when_auto_expand_is_true() {
        // ВОЗ no longer auto-expands (alternating CVC → reads as word); use ФСБ instead.
        let out = normalize_segments(vec![Segment::Text("ФСБ объявила".to_string())], true);
        assert_eq!(out, vec![Segment::Text("эф эс бэ объявила".to_string())]);
    }

    #[test]
    fn text_passes_through_when_auto_expand_is_false() {
        let out = normalize_segments(vec![Segment::Text("ВОЗ объявила".to_string())], false);
        assert_eq!(out, vec![Segment::Text("ВОЗ объявила".to_string())]);
    }

    #[test]
    fn spell_wins_even_when_auto_expand_is_false() {
        let out = normalize_segments(vec![Segment::Spell("ОН".to_string())], false);
        assert_eq!(out, vec![Segment::Text("о эн".to_string())]);
    }

    #[test]
    fn break_and_ipa_pass_through() {
        let segs = vec![
            Segment::Break(Duration::from_millis(500)),
            Segment::Ipa("ɪpɑ".to_string()),
        ];
        assert_eq!(normalize_segments(segs.clone(), true), segs);
    }

    #[test]
    fn emphasis_with_plus_marker_passes_through() {
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "д+ома".to_string(),
                suppress: false,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("д+ома".to_string())]);
    }

    #[test]
    fn emphasis_suppress_strips_plus() {
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "д+ома".to_string(),
                suppress: true,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("дома".to_string())]);
    }

    #[test]
    fn emphasis_without_plus_still_yields_text() {
        // Data shape only — the warn_once side-effect is tested by absence of
        // panic and by the helper's own tests in tts::ru::warn.
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "обычное слово".to_string(),
                suppress: false,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("обычное слово".to_string())]);
    }

    #[test]
    fn prosody_rate_recurses_spell_inside() {
        // Regression: <prosody rate="slow"><say-as characters>ФСБ</say-as></prosody>
        // must still letter-spell the inner content.
        let out = normalize_segments(
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![Segment::Spell("ФСБ".to_string())],
            }],
            false,
        );
        assert_eq!(
            out,
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![Segment::Text("эф эс бэ".to_string())],
            }]
        );
    }

    #[test]
    fn prosody_rate_recurses_acronym_expand_inside() {
        // Regression: ФСБ inside <prosody rate> must still auto-expand.
        let out = normalize_segments(
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![Segment::Text("ФСБ объявила".to_string())],
            }],
            true,
        );
        assert_eq!(
            out,
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![Segment::Text("эф эс бэ объявила".to_string())],
            }]
        );
    }
}
