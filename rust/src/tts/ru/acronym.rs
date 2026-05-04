//! Auto-detect all-uppercase Cyrillic acronyms in plain text and replace
//! them with letter-by-letter spellings via `letter_table::expand_chars`.
//!
//! Rules (see spec 2026-05-03 §"Acronym matcher"):
//! 1. Tokenize on Unicode whitespace, preserving the original spacing.
//! 2. Strip a leading run of `«("„` (head) and a trailing run of
//!    `.,:;!?»)„"…—–-` (tail); the rest is `core`.
//! 3. `core` must be 2..=5 chars, all `[А-ЯЁ]`, and not contain Ъ or Ь.
//! 4. `core` must not be in `STOP_LIST` (matches emphatic uppercase forms
//!    of common short Russian words like ОН, МЫ, КАК).
//! 5. `core` must pass `should_spell`: length ≤ 2, OR any adjacent same-type
//!    letter pair (both vowels or both consonants). Tokens with strict
//!    CV/CVC alternation (ВОЗ, КОТ, НАТО, ОПЕК) read fine as words and are
//!    NOT expanded. Closes #232.
//! 6. Otherwise, replace the token with `head + expand_chars(core) + tail`.

use super::letter_table::expand_chars;

/// Common short Russian words that are sometimes written in CAPS for emphasis.
/// They look like acronyms to the matcher but are not. Length 2..=5 only —
/// shorter / longer is already filtered by the length rule.
// Note: Я (length 1) is intentionally omitted — the length filter rejects length-1 tokens before the stop-list is consulted.
const STOP_LIST: &[&str] = &[
    "ВСЁ", "ВЫ", "ДА", "ДЛЯ", "ЕЁ", "ЕМУ", "ЕЩЁ", "ИЛИ", "ИМ", "ИХ", "КАК", "КТО", "МНЕ", "МЫ",
    "НЕ", "НЕТ", "НИ", "ОН", "ОНА", "ОНИ", "ОНО", "ТОТ", "ТЫ", "УЖ", "ЧТО",
];

const TRAILING_PUNCT: &[char] = &[
    '.', ',', ':', ';', '!', '?', '»', ')', '„', '"', '…', '—', '–', '-',
];

const LEADING_PUNCT: &[char] = &['«', '(', '"', '„'];

const VOWELS: &[char] = &['А', 'Е', 'Ё', 'И', 'О', 'У', 'Ы', 'Э', 'Ю', 'Я'];

fn is_vowel(c: char) -> bool {
    VOWELS.contains(&c)
}

/// User's rule (#232): spell out only if Vosk cannot read the token as a
/// natural Russian syllable — i.e. length ≤ 2 OR there's any pair of
/// adjacent same-type letters (both vowels or both consonants). Tokens
/// with strict CV/CVC alternation read fine as words (ВОЗ, КОТ, НАТО, ОПЕК).
fn should_spell(core: &str) -> bool {
    let chars: Vec<char> = core.chars().collect();
    if chars.len() <= 2 {
        return true;
    }
    chars.windows(2).any(|w| is_vowel(w[0]) == is_vowel(w[1]))
}

/// Returns true if `core` is a candidate acronym worth expanding.
/// Pure structural check — does not consult the stop-list.
fn is_acronym_token(core: &str) -> bool {
    let len = core.chars().count();
    if !(2..=5).contains(&len) {
        return false;
    }
    for c in core.chars() {
        // Reject anything outside [А-ЯЁ] and any soft/hard sign.
        let in_range = ('А'..='Я').contains(&c) || c == 'Ё';
        if !in_range {
            return false;
        }
        if c == 'Ъ' || c == 'Ь' {
            return false;
        }
    }
    should_spell(core)
}

/// Auto-expand all-uppercase Cyrillic acronyms in `input`. Whitespace and
/// non-acronym tokens are preserved verbatim.
pub(super) fn expand_acronyms(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut buf = String::new();
    for c in input.chars() {
        if c.is_whitespace() {
            // Flush pending token, then emit the whitespace.
            if !buf.is_empty() {
                out.push_str(&expand_token(&buf));
                buf.clear();
            }
            out.push(c);
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        out.push_str(&expand_token(&buf));
    }
    out
}

fn expand_token(token: &str) -> String {
    let (head, mid, tail) = split_punct(token);
    if !is_acronym_token(mid) {
        return token.to_string();
    }
    if STOP_LIST.contains(&mid) {
        return token.to_string();
    }
    let mut s = String::from(head);
    s.push_str(&expand_chars(mid));
    s.push_str(tail);
    s
}

/// Split `token` into (leading_punct, core, trailing_punct).
/// Leading and trailing punctuation runs are peeled off so that tokens like
/// `«ВОЗ»` or `ФСБ.` are correctly identified and expanded.
fn split_punct(token: &str) -> (&str, &str, &str) {
    // Find start of core (skip leading punct).
    let start = token
        .char_indices()
        .find(|(_, c)| !LEADING_PUNCT.contains(c))
        .map(|(i, _)| i)
        .unwrap_or(token.len());

    let rest = &token[start..];

    // Find end of core (peel trailing punct).
    let mut end = rest.len();
    for (idx, c) in rest.char_indices().rev() {
        if TRAILING_PUNCT.contains(&c) {
            end = idx;
        } else {
            break;
        }
    }

    let head = &token[..start];
    let core = &rest[..end];
    let tail = &rest[end..];
    (head, core, tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Vec<(&'static str, &'static str)> {
        vec![
            // Spell out — 0 vowels (all consonants → always has a same-type adjacent pair).
            ("ФСБ", "фэ эс бэ"),
            ("ФСБ.", "фэ эс бэ."),
            ("ФСБ объявила", "фэ эс бэ объявила"),
            ("СНГ", "сэ эн гэ"),
            ("МВД", "эм вэ дэ"),
            ("РЖД", "эр жэ дэ"),
            ("ВВП", "вэ вэ пэ"),
            // Spell out — consecutive vowels.
            ("ОАЭ", "о а э"),
            ("АЭС", "а э эс"),
            // Spell out — consonant cluster adjacent to vowel (США = С+Ш adjacent, both consonants).
            ("США", "сэ шэ а"),
            ("ЦСКА", "цэ эс ка а"),
            // Spell out — length 2 (always spell regardless of structure).
            ("ИП", "и пэ"),
            ("ЕС", "е эс"),
            ("РФ", "эр фэ"),
            // Don't spell — alternating CVC/CVCV (Vosk reads as word).
            ("ВОЗ", "ВОЗ"),
            ("КОТ", "КОТ"),
            ("НАТО", "НАТО"),
            ("ОПЕК", "ОПЕК"),
            // Stop-list preserved.
            ("ОН пришёл", "ОН пришёл"),
            ("МЫ идём", "МЫ идём"),
            // Inflected forms preserved.
            ("ВОЗа", "ВОЗа"),
            // Wrong shape preserved.
            ("дом", "дом"),
            ("НасА", "НасА"),
            ("NASA", "NASA"),
            ("В", "В"),
            ("АБВГДЕ", "АБВГДЕ"),
            // Soft/hard sign rejection.
            ("ОБЪЁМ", "ОБЪЁМ"),
            ("СЪЕЗД", "СЪЕЗД"),
            ("КРЕМЛЬ", "КРЕМЛЬ"),
            // Punctuation around a 0-vowel acronym.
            ("«ФСБ»", "«фэ эс бэ»"),
            ("ФСБ! СНГ?", "фэ эс бэ! сэ эн гэ?"),
            // Don't-spell tokens preserve their punct.
            ("ВОЗ.", "ВОЗ."),
            ("«НАТО»", "«НАТО»"),
        ]
    }

    #[test]
    fn matrix() {
        for (input, expected) in cases() {
            assert_eq!(expand_acronyms(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn vowel_cluster_or_short_or_consonant_cluster_only() {
        // 0 vowels (all consonants → always has a same-type adjacent pair) → spell.
        assert_eq!(expand_acronyms("ФСБ"), "фэ эс бэ");
        assert_eq!(expand_acronyms("МВД"), "эм вэ дэ");
        // Consecutive vowels → spell.
        assert_eq!(expand_acronyms("ОАЭ"), "о а э");
        // Consonant cluster adjacent + vowel → spell.
        assert_eq!(expand_acronyms("США"), "сэ шэ а");
        // Length 2 → spell (always; only stop-list overrides).
        assert_eq!(expand_acronyms("ИП"), "и пэ");
        assert_eq!(expand_acronyms("ЕС"), "е эс");
        // Alternating CVC / CVCV → don't spell.
        assert_eq!(expand_acronyms("ВОЗ"), "ВОЗ");
        assert_eq!(expand_acronyms("НАТО"), "НАТО");
        assert_eq!(expand_acronyms("ОПЕК"), "ОПЕК");
    }

    #[test]
    fn every_stop_list_entry_round_trips() {
        for w in STOP_LIST {
            assert_eq!(expand_acronyms(w), *w, "stop-list entry escaped: {w}");
        }
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(expand_acronyms(""), "");
    }

    #[test]
    fn pure_whitespace_passes_through() {
        assert_eq!(expand_acronyms("   "), "   ");
        assert_eq!(expand_acronyms("\n"), "\n");
    }
}
