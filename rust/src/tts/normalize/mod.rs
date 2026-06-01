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

/// Split a token into (leading_punct, core, trailing_punct).
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

    // Integer token?
    if let Ok(n) = core.parse::<u32>() {
        return format!("{head}{}{tail}", to_words(n, lang));
    }

    // Acronym token?
    if is_acronym_token(core) {
        return format!("{head}{}{tail}", spell(core, lang));
    }

    // Pass through verbatim.
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
}
