//! English-specific text normalization for the Kokoro path.
//!
//! Two tables: `letter_table::expand_chars` (letter-spelling) and
//! `acronym::IPA_LEXICON` / `acronym::STOP_LIST` (IPA overrides / pass-throughs).
//!
//! Closes #244.

pub(super) mod acronym;
pub(super) mod letter_table;

use crate::tts::ssml::Segment;

/// True for any English variant (`en`, `en-us`, `en-gb`, …).
/// Centralized so all call sites (plain/SSML/stdin-loop) agree on the gate.
pub fn is_en(lang: &str) -> bool {
    lang.starts_with("en")
}

/// Normalize a segment list for the Kokoro path.
/// `ProsodyRate` content is recursively normalized so that IPA_LEXICON
/// overrides, `<say-as characters>`, and `<emphasis>` warnings remain active
/// for nested segments.
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter()
        .flat_map(|s| match s {
            Segment::Spell(t) => vec![Segment::Text(letter_table::expand_chars(&t))],
            Segment::Emphasis { content, suppress } => {
                if !suppress {
                    crate::tts::warn::warn_once(
                        "emphasis-non-ru-vosk",
                        "<emphasis> stress markers are honored only on ru-vosk-* voices; \
                         stripping `+` from content for non-Vosk path",
                    );
                }
                let stripped = crate::tts::strip_emphasis_markers(content);
                vec![Segment::Text(stripped)]
            }
            Segment::Text(t) => acronym::expand_to_segments(&t, auto_expand),
            Segment::ProsodyRate { rate, content } => vec![Segment::ProsodyRate {
                rate,
                content: normalize_segments(content, auto_expand),
            }],
            other => vec![other],
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn spell_segment_becomes_text_via_letter_table() {
        let out = normalize_segments(vec![Segment::Spell("EPAM".to_string())], false);
        assert_eq!(out, vec![Segment::Text("ee pee ay em".to_string())]);
    }

    #[test]
    fn text_letter_spells_when_auto_expand() {
        // FBI letter-spells (no IPA_LEXICON entry, not on stop-list).
        let out = normalize_segments(vec![Segment::Text("FBI investigation".to_string())], true);
        assert_eq!(
            out,
            vec![Segment::Text("ef bee eye investigation".to_string())]
        );
    }

    #[test]
    fn text_passes_through_when_auto_expand_false_and_no_lexicon_hit() {
        let out = normalize_segments(vec![Segment::Text("FBI investigation".to_string())], false);
        assert_eq!(out, vec![Segment::Text("FBI investigation".to_string())]);
    }

    #[test]
    fn ipa_lexicon_hit_emits_ipa_segment() {
        let out = normalize_segments(vec![Segment::Text("EPAM partners".to_string())], true);
        assert_eq!(
            out,
            vec![
                Segment::Ipa("ˈiːpæm".to_string()),
                Segment::Text(" partners".to_string()),
            ]
        );
    }

    #[test]
    fn ipa_lexicon_fires_even_without_auto_expand() {
        // Lexicon overrides are intent-explicit; not gated by auto_expand.
        let out = normalize_segments(vec![Segment::Text("EPAM partners".to_string())], false);
        assert_eq!(
            out,
            vec![
                Segment::Ipa("ˈiːpæm".to_string()),
                Segment::Text(" partners".to_string()),
            ]
        );
    }

    #[test]
    fn spell_wins_even_when_auto_expand_is_false() {
        let out = normalize_segments(vec![Segment::Spell("OK".to_string())], false);
        assert_eq!(out, vec![Segment::Text("oh kay".to_string())]);
    }

    #[test]
    fn break_and_ipa_pass_through() {
        let segs = vec![
            Segment::Break(Duration::from_millis(500)),
            Segment::Ipa("əˈpæm".to_string()),
        ];
        assert_eq!(normalize_segments(segs.clone(), true), segs);
    }

    #[test]
    fn emphasis_strips_plus_marker_and_yields_text() {
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "д+ома".to_string(),
                suppress: false,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("дома".to_string())]);
    }

    #[test]
    fn emphasis_without_plus_still_yields_text() {
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "regular text".to_string(),
                suppress: false,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("regular text".to_string())]);
    }

    #[test]
    fn emphasis_suppress_strips_plus_without_warning() {
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
    fn prosody_rate_recurses_ipa_lexicon_inside() {
        // Regression: EPAM inside <prosody rate> must still hit IPA_LEXICON.
        let out = normalize_segments(
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![Segment::Text("EPAM partners".to_string())],
            }],
            false,
        );
        assert_eq!(
            out,
            vec![Segment::ProsodyRate {
                rate: 0.75,
                content: vec![
                    Segment::Ipa("ˈiːpæm".to_string()),
                    Segment::Text(" partners".to_string()),
                ],
            }]
        );
    }

    #[test]
    fn prosody_rate_recurses_spell_inside() {
        // Regression: <prosody rate><say-as characters>EPAM</say-as></prosody>
        // must still letter-spell the inner content.
        let out = normalize_segments(
            vec![Segment::ProsodyRate {
                rate: 1.25,
                content: vec![Segment::Spell("EPAM".to_string())],
            }],
            false,
        );
        assert_eq!(
            out,
            vec![Segment::ProsodyRate {
                rate: 1.25,
                content: vec![Segment::Text("ee pee ay em".to_string())],
            }]
        );
    }
}
