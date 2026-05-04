//! Cyrillic letter-name table for spelling-out abbreviations.
//!
//! Joined with single spaces (Vosk's BERT prosody behaves better on
//! space-separated tokens than on dash-joined ones). Ъ and Ь are
//! silent; their entries are kept in the table for completeness so the
//! match is exhaustive.
//!
//! Letter-name forms are tuned to user-validated pronunciation (#232):
//! Л = "эл" (not "эль"), Ф = "фэ" (not "эф"), Ш = "шэ" (not "ша").
//! С is position-dependent: "сэ" at index 0 (start of token), "эс" elsewhere
//! (e.g. США → "сэ шэ а", ФСБ → "фэ эс бэ", ЕС → "е эс").

// Russian letter-name table for acronym spell-out. Forms chosen to match
// what Vosk-TTS BERT-prosody pronounces naturally — see #232 user-listening
// feedback. Position-dependent rule for С (handled in expand_chars below).
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
    ('л', "эл"),
    ('м', "эм"),
    ('н', "эн"),
    ('о', "о"),
    ('п', "пэ"),
    ('р', "эр"),
    ('с', "эс"),
    ('т', "тэ"),
    ('у', "у"),
    ('ф', "фэ"),
    ('х', "ха"),
    ('ц', "цэ"),
    ('ч', "че"),
    ('ш', "шэ"),
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
///
/// Position-dependent rule: С at index 0 (start of the token) uses "сэ";
/// С elsewhere uses "эс". E.g. США → "сэ шэ а", ФСБ → "фэ эс бэ".
pub(super) fn expand_chars(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    // `last_was_cyrillic` tracks whether the previous emitted token was a
    // Cyrillic letter-name. Spaces are inserted only between tokens that
    // involve at least one Cyrillic side, so pure non-Cyrillic runs pass
    // through without inserted spaces (e.g. "---" → "---") while mixed
    // runs still get spaces (e.g. "AБ1" → "A бэ 1").
    let mut last_was_cyrillic = false;
    for (i, c) in input.chars().enumerate() {
        // Cyrillic uppercase always lowercases to a single char; unwrap_or(c)
        // handles non-Cyrillic passthrough.
        let lc = c.to_lowercase().next().unwrap_or(c);

        // Position-dependent: С at the start of the token uses "сэ" form
        // (e.g. США → "сэ шэ а"), but in middle/end uses "эс" (ФСБ → "фэ эс бэ",
        // ЕС → "е эс"). User-specified per #232.
        let name = if i == 0 && lc == 'с' {
            Some("сэ")
        } else {
            LETTERS.iter().find(|(k, _)| *k == lc).map(|(_, v)| *v)
        };

        match name {
            Some("") => {} // silent (Ъ, Ь)
            Some(s) => {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(s);
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
        // expand_chars exercises the unconditional spelling path (not the
        // auto-detect path). ВОЗ starts with В, so no С-at-start override applies.
        assert_eq!(expand_chars("ВОЗ"), "вэ о зэ");
    }

    #[test]
    fn cska_expands_to_four_letter_names() {
        // С is at index 1 (not start) → "эс".
        assert_eq!(expand_chars("ЦСКА"), "цэ эс ка а");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(expand_chars(""), "");
    }

    #[test]
    fn yo_is_distinct_from_ye() {
        assert_eq!(expand_chars("ЁЛЬ"), "ё эл");
        assert_eq!(expand_chars("ЕЛЬ"), "е эл");
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

    #[test]
    fn s_at_start_uses_se_form() {
        // С at index 0 → "сэ" (user-confirmed: США → "сэ шэ а").
        assert_eq!(expand_chars("США"), "сэ шэ а");
        assert_eq!(expand_chars("СНГ"), "сэ эн гэ");
    }

    #[test]
    fn s_in_middle_or_end_uses_es_form() {
        // С not at index 0 → "эс" (user-confirmed).
        assert_eq!(expand_chars("ФСБ"), "фэ эс бэ");
        assert_eq!(expand_chars("ЕС"), "е эс");
        assert_eq!(expand_chars("АЭС"), "а э эс");
        assert_eq!(expand_chars("ЦСКА"), "цэ эс ка а");
    }

    #[test]
    fn updated_letter_forms() {
        // Ф is now "фэ" (not "эф") — user-confirmed.
        assert_eq!(expand_chars("РФ"), "эр фэ");
        // Ш is now "шэ" (not "ша") — user-confirmed.
        assert_eq!(expand_chars("ШУМ"), "шэ у эм");
        // Л is now "эл" (not "эль") — user-confirmed.
        assert_eq!(expand_chars("ЛЛМ"), "эл эл эм");
    }
}
