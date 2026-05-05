//! Russian-specific text normalization for the Vosk-TTS path.
//!
//! Two responsibilities — both pure text-in / text-out:
//! - `letter_table::expand_chars` — letter-by-letter spelling
//!   for `<say-as interpret-as="characters">`.
//! - `acronym::expand_acronyms` — auto-detect all-uppercase
//!   Cyrillic acronyms in plain text (added in T4).
//!
//! `normalize_segments` (added in T5) routes [`crate::tts::ssml::Segment`]
//! values through the appropriate primitive.

pub(super) mod acronym;
pub(super) mod letter_table;
pub(super) mod warn;

use crate::tts::ssml::Segment;

/// Auto-expand all-uppercase Cyrillic acronyms in plain text. Used by the
/// non-SSML Vosk path; the SSML path goes through `normalize_segments`
/// instead so it can also handle `Segment::Spell`.
pub fn expand_text(text: &str) -> String {
    acronym::expand_acronyms(text)
}

/// Normalize a segment list for the Russian Vosk path:
/// - `Spell(t)` → `Text(letter_table::expand_chars(t))`
/// - `Emphasis(_)` is converted to `Text` here: `suppress=true` strips `+`
///   markers; `suppress=false` passes content through verbatim and emits a
///   once-per-process warning when no `+` marker is present (caller has not
///   provided a usable stress hint).
/// - `Text(t)`  → `Text(acronym::expand_acronyms(t))` if `auto_expand`
/// - `Ipa(_)`, `Break(_)` → unchanged
///
/// `<say-as interpret-as="characters">` always wins (its content is the
/// inner text of a `Spell` segment by the time we get here, so the
/// `auto_expand` flag does not gate it).
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter()
        .map(|s| match s {
            Segment::Spell(t) => Segment::Text(letter_table::expand_chars(&t)),
            Segment::Emphasis { content, suppress } => {
                if suppress {
                    Segment::Text(content.replace('+', ""))
                } else {
                    if !content.contains('+') {
                        warn::warn_once(
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
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
        // Confirms <say-as> isn't silenced by --no-expand-abbrev.
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
    fn emphasis_with_multiple_plus_markers_pass_all_through() {
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "я зн+аю это".to_string(),
                suppress: false,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("я зн+аю это".to_string())]);
    }

    #[test]
    fn emphasis_suppress_strips_multiple_plus_markers() {
        let out = normalize_segments(
            vec![Segment::Emphasis {
                content: "я зн+аю +это".to_string(),
                suppress: true,
            }],
            false,
        );
        assert_eq!(out, vec![Segment::Text("я знаю это".to_string())]);
    }
}
