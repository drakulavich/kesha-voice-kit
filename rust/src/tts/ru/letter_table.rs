//! Cyrillic letter-name table for spelling-out abbreviations.
//!
//! Joined with single spaces (Vosk's BERT prosody behaves better on
//! space-separated tokens than on dash-joined ones). Ъ and Ь are
//! silent; their entries are kept in the table for completeness so the
//! match is exhaustive.

// dead_code allow: the consumer (tts::ru::normalize_segments) lands in T5
// and the bin reachability via synth_segments_vosk_with lands in T6 (#232).
// REMOVE this allow when T6 lands. cargo clippy --all-targets fires on the
// bin target until then because main.rs has no caller in its reachability
// graph yet.
#![allow(dead_code)]

const LETTERS: &[(char, &str)] = &[
    ('а', "а"),
    ('б', "бэ"),
    ('в', "вэ"),
    ('г', "гэ"),
    ('д', "дэ"),
    ('е', "е"),
    ('ё', "ё"),
    ('ж', "жэ"),
    ('з', "зэ"),
    ('и', "и"),
    ('й', "ий"),
    ('к', "ка"),
    ('л', "эль"),
    ('м', "эм"),
    ('н', "эн"),
    ('о', "о"),
    ('п', "пэ"),
    ('р', "эр"),
    ('с', "эс"),
    ('т', "тэ"),
    ('у', "у"),
    ('ф', "эф"),
    ('х', "ха"),
    ('ц', "цэ"),
    ('ч', "че"),
    ('ш', "ша"),
    ('щ', "ща"),
    ('ъ', ""),
    ('ы', "ы"),
    ('ь', ""),
    ('э', "э"),
    ('ю', "ю"),
    ('я', "я"),
];

/// Expand `input` to space-separated Russian letter names.
/// Non-Cyrillic characters pass through unchanged. Silent letters
/// (Ъ, Ь) are dropped without leaving a double space.
pub(super) fn expand_chars(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    // `last_was_cyrillic` tracks whether the previous emitted token was a
    // Cyrillic letter-name. Spaces are inserted only between tokens that
    // involve at least one Cyrillic side, so pure non-Cyrillic runs pass
    // through without inserted spaces (e.g. "---" → "---") while mixed
    // runs still get spaces (e.g. "AБ1" → "A бэ 1").
    let mut last_was_cyrillic = false;
    for c in input.chars() {
        // Cyrillic uppercase always lowercases to a single char; unwrap_or(c) handles non-Cyrillic passthrough.
        let lc = c.to_lowercase().next().unwrap_or(c);
        match LETTERS.iter().find(|(k, _)| *k == lc) {
            Some((_, "")) => {} // silent (Ъ, Ь)
            Some((_, name)) => {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(name);
                last_was_cyrillic = true;
            }
            None => {
                if last_was_cyrillic {
                    out.push(' ');
                }
                out.push(c);
                last_was_cyrillic = false;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voz_expands_to_three_letter_names() {
        assert_eq!(expand_chars("ВОЗ"), "вэ о зэ");
    }

    #[test]
    fn cska_expands_to_four_letter_names() {
        assert_eq!(expand_chars("ЦСКА"), "цэ эс ка а");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(expand_chars(""), "");
    }

    #[test]
    fn yo_is_distinct_from_ye() {
        assert_eq!(expand_chars("ЁЛЬ"), "ё эль");
        assert_eq!(expand_chars("ЕЛЬ"), "е эль");
    }

    #[test]
    fn yat_is_silent_no_double_space() {
        // ОБЪЁМ would be word-shaped, but we still want a clean expansion if forced.
        assert_eq!(expand_chars("ОБЪЁМ"), "о бэ ё эм");
    }

    #[test]
    fn soft_sign_is_silent() {
        assert_eq!(expand_chars("МЬ"), "эм");
    }

    #[test]
    fn full_alphabet_round_trip() {
        // Each cyrillic letter must produce a non-empty token unless it's Ъ/Ь.
        let alphabet = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
        let result = expand_chars(alphabet);
        let pieces: Vec<&str> = result.split(' ').collect();
        // 33 letters minus the two silent (Ъ, Ь) = 31 audible tokens.
        assert_eq!(pieces.len(), 31, "got: {result}");
    }

    #[test]
    fn lowercase_input_works() {
        assert_eq!(expand_chars("воз"), "вэ о зэ");
    }

    #[test]
    fn non_cyrillic_passes_through() {
        // The matcher (T4) won't pass non-Cyrillic to us; this is a sanity guard
        // for explicit <say-as> with mixed input.
        assert_eq!(expand_chars("AБ1"), "A бэ 1");
    }

    #[test]
    fn pure_non_cyrillic_passes_through_without_leading_space() {
        assert_eq!(expand_chars("---"), "---");
        assert_eq!(expand_chars("123"), "123");
    }
}
