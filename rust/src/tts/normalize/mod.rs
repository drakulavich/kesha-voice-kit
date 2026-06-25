//! Per-language text normalizer: expands digits and all-caps acronyms before G2P.
//!
//! Supports es (Spanish), fr (French), it (Italian), pt (Portuguese).
//! For any other language (including en) the text is returned unchanged —
//! English normalization is handled upstream in `tts::en`.
pub(crate) mod acronyms;
pub(crate) mod numbers;

use acronyms::{is_acronym_token, spell};
use numbers::to_words;

const TRAILING_PUNCT: &[char] = &[
    '.', ',', ':', ';', '!', '?', '»', ')', '„', '"', '…', '—', '–', '-',
];
const LEADING_PUNCT: &[char] = &['«', '(', '"', '„'];

fn split_punct(token: &str) -> (&str, &str, &str) {
    let start = token
        .char_indices()
        .find(|(_, c)| !LEADING_PUNCT.contains(c))
        .map(|(i, _)| i)
        .unwrap_or(token.len());
    let rest = &token[start..];
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

/// Normalize one whitespace-separated token for lang ∈ {es, fr, it, pt}.
fn normalize_token(token: &str, lang: &str) -> String {
    let (head, core, tail) = split_punct(token);

    // Only expand 0..=999_999; larger numbers pass through verbatim so G2P never crashes.
    if let Ok(n) = core.parse::<u32>() {
        if n <= 999_999 {
            return format!("{head}{}{tail}", to_words(n, lang));
        }
        return token.to_string();
    }

    if is_acronym_token(core) {
        return format!("{head}{}{tail}", spell(core, lang));
    }

    token.to_string()
}

/// Normalize `text` for the given language before G2P.
///
/// For lang ∈ {`"es"`, `"fr"`, `"it"`, `"pt"`}: walks whitespace-separated
/// tokens, expanding integers to words and all-caps 2..=5 letter runs to their
/// per-language letter names. Surrounding punctuation is preserved.
///
/// For any other language (including `"en"`): returns `text` unchanged.
pub fn normalize(text: &str, lang: &str) -> String {
    if !matches!(lang, "es" | "fr" | "it" | "pt") {
        return text.to_string();
    }

    let mut result = String::with_capacity(text.len() + 32);
    let mut tok_buf = String::new();

    for c in text.chars() {
        if c.is_whitespace() {
            if !tok_buf.is_empty() {
                result.push_str(&normalize_token(&tok_buf, lang));
                tok_buf.clear();
            }
            result.push(c);
        } else {
            tok_buf.push(c);
        }
    }
    if !tok_buf.is_empty() {
        result.push_str(&normalize_token(&tok_buf, lang));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_expands_digits_and_acronyms_es() {
        let out = normalize("Compré 27 libros RAI", "es");
        assert!(out.contains("veintisiete"), "got: {out}");
        assert!(out.contains("erre a i"), "got: {out}");
        assert!(!out.contains("27"), "digit leaked: {out}");
    }

    #[test]
    fn normalize_leaves_english_untouched() {
        assert_eq!(normalize("hello 5", "en"), "hello 5");
    }

    #[test]
    fn normalize_via_base_lang_handles_region_tagged_es() {
        // The region subtag (es-ES) is reduced to the base lang upstream before
        // `normalize` is called; this locks that numbers/acronyms still expand
        // identically to bare "es" (i.e. the region tag never silently disables
        // expansion). Passing the raw "es-ES" tag would NOT match and skip it.
        let base = crate::tts::charsiu::base_lang("es-ES");
        assert_eq!(base, "es");
        assert_eq!(normalize("27 OTAN", base), normalize("27 OTAN", "es"));
        assert!(normalize("27 OTAN", base).contains("veintisiete"));
        // The raw region tag is intentionally inert in `normalize` itself.
        assert_eq!(normalize("27 OTAN", "es-ES"), "27 OTAN");
    }

    #[test]
    fn normalize_large_number_does_not_panic() {
        // Numbers >= 1_000_000 are outside the word-table range; they must pass
        // through verbatim rather than panicking.
        let out = normalize("Año 1000000", "es");
        assert!(
            out.contains("1000000"),
            "large number should be verbatim, got: {out}"
        );
        assert!(out.contains("Año"), "got: {out}");
        // u32::MAX must also be safe.
        let max = normalize("4294967295", "es");
        assert!(max.contains("4294967295"), "got: {max}");
    }
}
