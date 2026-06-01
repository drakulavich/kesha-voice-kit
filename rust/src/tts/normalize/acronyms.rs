//! Per-language letter-name spelling for all-caps acronym tokens.

// ── Letter-name tables ────────────────────────────────────────────────────────

/// Spanish letter names (a-z).
/// Source: Real Academia Española standard names.
const ES_LETTERS: [(&str, &str); 27] = [
    ("A", "a"),
    ("B", "be"),
    ("C", "ce"),
    ("D", "de"),
    ("E", "e"),
    ("F", "efe"),
    ("G", "ge"),
    ("H", "hache"),
    ("I", "i"),
    ("J", "jota"),
    ("K", "ka"),
    ("L", "ele"),
    ("M", "eme"),
    ("N", "ene"),
    ("O", "o"),
    ("P", "pe"),
    ("Q", "cu"),
    ("R", "erre"),
    ("S", "ese"),
    ("T", "te"),
    ("U", "u"),
    ("V", "uve"),
    ("W", "uve doble"),
    ("X", "equis"),
    ("Y", "i griega"),
    ("Z", "zeta"),
    // Ñ is not typically in acronyms but include for completeness
    ("Ñ", "eñe"),
];

/// French letter names (a-z).
/// Source: standard French alphabet letter names.
const FR_LETTERS: [(&str, &str); 26] = [
    ("A", "a"),
    ("B", "bé"),
    ("C", "cé"),
    ("D", "dé"),
    ("E", "e"),
    ("F", "effe"),
    ("G", "gé"),
    ("H", "ache"),
    ("I", "i"),
    ("J", "ji"),
    ("K", "ka"),
    ("L", "elle"),
    ("M", "emme"),
    ("N", "enne"),
    ("O", "o"),
    ("P", "pé"),
    ("Q", "ku"),
    ("R", "erre"),
    ("S", "esse"),
    ("T", "té"),
    ("U", "u"),
    ("V", "vé"),
    ("W", "double vé"),
    ("X", "ixe"),
    ("Y", "i grec"),
    ("Z", "zède"),
];

/// Italian letter names (a-z).
/// Source: standard Italian alphabet letter names.
// Includes J/K/W/X/Y (not in the traditional 21-letter alphabet but common in
// modern Italian acronyms — WC, OK, etc.); standard letter names. Greptile #509 P2.
const IT_LETTERS: [(&str, &str); 26] = [
    ("A", "a"),
    ("B", "bi"),
    ("C", "ci"),
    ("D", "di"),
    ("E", "e"),
    ("F", "effe"),
    ("G", "gi"),
    ("H", "acca"),
    ("I", "i"),
    ("J", "i lunga"),
    ("K", "cappa"),
    ("L", "elle"),
    ("M", "emme"),
    ("N", "enne"),
    ("O", "o"),
    ("P", "pi"),
    ("Q", "cu"),
    ("R", "erre"),
    ("S", "esse"),
    ("T", "ti"),
    ("U", "u"),
    ("V", "vi"),
    ("W", "doppia vu"),
    ("X", "ics"),
    ("Y", "ipsilon"),
    ("Z", "zeta"),
];

/// Portuguese letter names (a-z).
/// Source: standard Portuguese alphabet letter names.
const PT_LETTERS: [(&str, &str); 26] = [
    ("A", "á"),
    ("B", "bê"),
    ("C", "cê"),
    ("D", "dê"),
    ("E", "é"),
    ("F", "efe"),
    ("G", "gê"),
    ("H", "agá"),
    ("I", "i"),
    ("J", "jota"),
    ("K", "cá"),
    ("L", "ele"),
    ("M", "eme"),
    ("N", "ene"),
    ("O", "ó"),
    ("P", "pê"),
    ("Q", "quê"),
    ("R", "erre"),
    ("S", "esse"),
    ("T", "tê"),
    ("U", "u"),
    ("V", "vê"),
    ("W", "dáblio"),
    ("X", "xis"),
    ("Y", "ípsilon"),
    ("Z", "zê"),
];

// ── Stop-lists: all-caps tokens read as WORDS, not spelled out ───────────────
// Hand-curated seeds, ALL-CAPS keys. NOT exhaustive — extend by ear. Mirrors
// `tts/en/acronym.rs::STOP_LIST`. Initialisms that SHOULD spell (DNI, ADN, RAI,
// EUA) are deliberately absent.
pub(crate) const ES_STOP_LIST: &[&str] = &[
    "OTAN", "OVNI", "SIDA", "OPEP", "OEA", "ONU", "UNESCO", "FIFA", "OMS",
];
pub(crate) const FR_STOP_LIST: &[&str] = &[
    "OTAN", "OVNI", "SIDA", "UNESCO", "FIFA", "OPEP", "ONU", "OMS",
];
pub(crate) const IT_STOP_LIST: &[&str] = &["FIAT", "NATO", "FIFA", "AIDS", "UNESCO", "ONU"];
pub(crate) const PT_STOP_LIST: &[&str] = &[
    "OTAN", "OVNI", "SIDA", "AIDS", "FIFA", "UNESCO", "ONU", "OMS",
];

/// True if `token` is in `lang`'s stop-list (read as a word, not letter-spelled).
fn is_stop_listed(token: &str, lang: &str) -> bool {
    let list: &[&str] = match lang {
        "es" => ES_STOP_LIST,
        "fr" => FR_STOP_LIST,
        "it" => IT_STOP_LIST,
        "pt" => PT_STOP_LIST,
        _ => &[],
    };
    list.iter().any(|w| w.eq_ignore_ascii_case(token))
}

fn lookup_letter(ch: char, table: &[(&str, &str)]) -> String {
    let s = ch.to_string();
    table
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(&s))
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| ch.to_lowercase().to_string())
}

/// Returns true if `token` is a candidate for letter-by-letter spelling.
/// Mirrors `en/acronym.rs::is_acronym_token`: all-caps, length 2..=5.
pub fn is_acronym_token(token: &str) -> bool {
    let len = token.chars().count();
    if !(2..=5).contains(&len) {
        return false;
    }
    token.chars().all(|c| c.is_ascii_uppercase())
}

/// Spell `token` letter-by-letter using the language's standard letter names.
///
/// `token` should be the punct-stripped core (all ASCII uppercase, 2..=5 chars).
/// Letter names are joined with spaces. Unknown languages fall back to lowercased
/// individual characters joined with spaces.
pub fn spell(token: &str, lang: &str) -> String {
    // Word-acronyms (read as words) pass through unspelled.
    if is_stop_listed(token, lang) {
        return token.to_string();
    }
    let names: Vec<String> = match lang {
        "es" => token
            .chars()
            .map(|c| lookup_letter(c, &ES_LETTERS))
            .collect(),
        "fr" => token
            .chars()
            .map(|c| lookup_letter(c, &FR_LETTERS))
            .collect(),
        "it" => token
            .chars()
            .map(|c| lookup_letter(c, &IT_LETTERS))
            .collect(),
        "pt" => token
            .chars()
            .map(|c| lookup_letter(c, &PT_LETTERS))
            .collect(),
        _ => token
            .chars()
            .map(|c| c.to_lowercase().to_string())
            .collect(),
    };
    names.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spells_acronyms_with_spanish_letter_names() {
        assert_eq!(spell("RAI", "es"), "erre a i");
        assert_eq!(spell("IBGE", "pt"), "i bê gê é");
    }

    #[test]
    fn spells_italian_acronyms_including_jkwxy() {
        assert_eq!(spell("RAI", "it"), "erre a i");
        // J/K/W/X/Y now resolve to standard Italian names, not raw-lowercase fallback.
        assert_eq!(spell("WC", "it"), "doppia vu ci");
        assert_eq!(spell("OK", "it"), "o cappa");
    }

    #[test]
    fn stop_listed_word_acronyms_pass_through_unspelled() {
        assert_eq!(spell("OTAN", "es"), "OTAN");
        assert_eq!(spell("OVNI", "es"), "OVNI");
        assert_eq!(spell("FIFA", "fr"), "FIFA");
        assert_eq!(spell("FIAT", "it"), "FIAT");
        assert_eq!(spell("SIDA", "pt"), "SIDA");
        // True initialisms still spell letter-by-letter.
        assert_eq!(spell("DNI", "es"), "de ene i");
        // Cross-language isolation: "OEA" is es/pt-list only; under "it" it letter-spells.
        assert_eq!(spell("OEA", "it"), "o e a");
    }

    #[test]
    fn every_stop_list_entry_passes_through() {
        for (lang, list) in [
            ("es", ES_STOP_LIST),
            ("fr", FR_STOP_LIST),
            ("it", IT_STOP_LIST),
            ("pt", PT_STOP_LIST),
        ] {
            for w in list {
                assert_eq!(
                    spell(w, lang),
                    *w,
                    "stop-list entry was spelled: {w} ({lang})"
                );
            }
        }
    }
}
