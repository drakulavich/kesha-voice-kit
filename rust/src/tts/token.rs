//! Token-level helpers shared by the per-language text normalizers
//! (`en::acronym`, `ru::acronym`, `normalize`).

pub(crate) const TRAILING_PUNCT: &[char] = &[
    '.', ',', ':', ';', '!', '?', '»', ')', '„', '"', '…', '—', '–', '-',
];

pub(crate) const LEADING_PUNCT: &[char] = &['«', '(', '"', '„'];

/// Peel leading/trailing punctuation so `«ВОЗ».` matches as `ВОЗ`:
/// returns `(head, core, tail)` slices of the original token.
pub(crate) fn split_punct(token: &str) -> (&str, &str, &str) {
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

/// One event of a whitespace-separated walk: a token, or a single gap char
/// (whitespace is forwarded verbatim so sentence shape survives rebuilding).
pub(crate) enum TokenEvent<'a> {
    Token(&'a str),
    Gap(char),
}

/// Walk `text`, emitting every token and every whitespace char in order.
pub(crate) fn for_each_token(text: &str, mut f: impl FnMut(TokenEvent<'_>)) {
    let mut tok = String::new();
    for c in text.chars() {
        if c.is_whitespace() {
            if !tok.is_empty() {
                f(TokenEvent::Token(&tok));
                tok.clear();
            }
            f(TokenEvent::Gap(c));
        } else {
            tok.push(c);
        }
    }
    if !tok.is_empty() {
        f(TokenEvent::Token(&tok));
    }
}

/// All-caps ASCII, length 2..=5 — the Latin acronym-candidate check shared by
/// the English segmenter and the Romance normalizer.
pub(crate) fn is_ascii_acronym(core: &str) -> bool {
    let len = core.chars().count();
    if !(2..=5).contains(&len) {
        return false;
    }
    core.chars().all(|c| c.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_punct_peels_both_ends() {
        assert_eq!(split_punct("«ВОЗ»."), ("«", "ВОЗ", "»."));
        assert_eq!(split_punct("(IBM),"), ("(", "IBM", "),"));
        assert_eq!(split_punct("word"), ("", "word", ""));
        assert_eq!(split_punct("..."), ("", "", "..."));
    }

    #[test]
    fn for_each_token_round_trips_text() {
        let text = "one  two\tthree\n";
        let mut rebuilt = String::new();
        for_each_token(text, |ev| match ev {
            TokenEvent::Token(t) => rebuilt.push_str(t),
            TokenEvent::Gap(c) => rebuilt.push(c),
        });
        assert_eq!(rebuilt, text);
    }

    #[test]
    fn is_ascii_acronym_bounds() {
        assert!(is_ascii_acronym("AI"));
        assert!(is_ascii_acronym("NASA"));
        assert!(!is_ascii_acronym("A"));
        assert!(!is_ascii_acronym("TOOLONG"));
        assert!(!is_ascii_acronym("НАТО"));
        assert!(!is_ascii_acronym("Ibm"));
    }
}
