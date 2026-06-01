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
const IT_LETTERS: [(&str, &str); 21] = [
    ("A", "a"),
    ("B", "bi"),
    ("C", "ci"),
    ("D", "di"),
    ("E", "e"),
    ("F", "effe"),
    ("G", "gi"),
    ("H", "acca"),
    ("I", "i"),
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
}
