use super::{join_segment_texts, TranscriptionOutput};

/// Rewrite spoken-form numbers, money, dates and times to written form.
///
/// Applies per segment so `--timestamps` survives: the pass changes token
/// counts inside a segment's text but never its `start`/`end`, and the
/// transcript is rebuilt from the segments so the two cannot drift. Segments
/// whose text normalizes to nothing are kept as-is rather than dropped —
/// callers rely on segment count matching the un-normalized run.
pub fn normalize_output(mut output: TranscriptionOutput) -> TranscriptionOutput {
    if output.segments.is_empty() {
        output.text = normalize_text(&output.text);
        return output;
    }
    for segment in &mut output.segments {
        segment.text = normalize_text(&segment.text);
    }
    output.text = join_segment_texts(&output.segments);
    output
}

/// Upstream's punctuation vocabulary (`itn/en/punctuation.rs` at the `8a043f1`
/// pin), split by token count so two-token names match before their tail word.
/// Kesha transcribes natural speech, not dictation, so a spoken punctuation
/// name is a noun here and never becomes a symbol (#822).
const PUNCTUATION_NAME_PAIRS: &[&str] = &[
    "exclamation point",
    "exclamation mark",
    "question mark",
    "open parenthesis",
    "close parenthesis",
    "left parenthesis",
    "right parenthesis",
    "open bracket",
    "close bracket",
    "left bracket",
    "right bracket",
    "open brace",
    "close brace",
    "left brace",
    "right brace",
    "double quote",
    "single quote",
    "forward slash",
    "back slash",
    "at sign",
];

const PUNCTUATION_NAMES: &[&str] = &[
    "period",
    "dot",
    "comma",
    "colon",
    "semicolon",
    "hyphen",
    "dash",
    "ellipsis",
    "ampersand",
    "asterisk",
    "hash",
    "percent",
    "plus",
    "equals",
    "tilde",
    "underscore",
    "pipe",
    "slash",
];

/// Object-replacement character: no upstream tagger matches a span containing
/// it, and the pretokenizer neither splits nor absorbs it.
const PUNCTUATION_MASK: &str = "\u{FFFC}";

/// `normalize_sentence` trims its input and can return an empty string for
/// whitespace-only text; keep the original in that case so the pass can only
/// ever rewrite content, never erase it.
fn normalize_text(text: &str) -> String {
    let masked = mask_punctuation_names(text);
    let source = masked.as_ref().map_or(text, |(masked, _)| masked.as_str());
    let normalized = text_processing_rs::normalize_sentence(source);
    let normalized = match &masked {
        Some((_, names)) => restore_punctuation_names(&normalized, names),
        None => normalized,
    };
    if normalized.trim().is_empty() && !text.trim().is_empty() {
        return text.to_string();
    }
    normalized
}

/// Replace every spoken punctuation name with [`PUNCTUATION_MASK`], returning
/// the masked text and the original words in order. `None` when there is
/// nothing to protect, so untouched text reaches upstream byte-identical.
fn mask_punctuation_names(text: &str) -> Option<(String, Vec<String>)> {
    if text.contains(PUNCTUATION_MASK) {
        return None;
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut masked: Vec<&str> = Vec::with_capacity(words.len());
    let mut names: Vec<String> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let core = punctuation_core(words[i]);
        let pair = words
            .get(i + 1)
            .map(|next| format!("{core} {}", punctuation_core(next)));
        if pair.is_some_and(|pair| PUNCTUATION_NAME_PAIRS.contains(&pair.as_str())) {
            names.push(format!("{} {}", words[i], words[i + 1]));
            masked.push(PUNCTUATION_MASK);
            i += 2;
        } else if PUNCTUATION_NAMES.contains(&core.as_str()) {
            names.push(words[i].to_string());
            masked.push(PUNCTUATION_MASK);
            i += 1;
        } else {
            masked.push(words[i]);
            i += 1;
        }
    }
    if names.is_empty() {
        return None;
    }
    Some((masked.join(" "), names))
}

fn punctuation_core(word: &str) -> String {
    word.trim_matches(|c: char| c.is_ascii_punctuation())
        .to_lowercase()
}

fn restore_punctuation_names(text: &str, names: &[String]) -> String {
    let mut names = names.iter();
    let mut out = String::with_capacity(text.len());
    for (index, part) in text.split(PUNCTUATION_MASK).enumerate() {
        if index > 0 {
            out.push_str(names.next().map_or(PUNCTUATION_MASK, String::as_str));
        }
        out.push_str(part);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcribe::TranscriptionSegment;

    fn segment(start: f32, end: f32, text: &str) -> TranscriptionSegment {
        TranscriptionSegment {
            start,
            end,
            text: text.to_string(),
            speaker: None,
        }
    }

    #[test]
    fn rewrites_english_number_words_to_digits() {
        let out = normalize_output(TranscriptionOutput {
            text: "there are two hundred thirty two open pull requests".into(),
            segments: vec![],
        });
        assert_eq!(out.text, "there are 232 open pull requests");
    }

    #[test]
    fn rewrites_money_and_ordinal_dates() {
        assert_eq!(
            normalize_text("it costs five dollars and fifty cents"),
            "it costs $5.50"
        );
        assert_eq!(
            normalize_text("review pull request number forty two"),
            "review pull request number 42"
        );
    }

    #[test]
    fn leaves_russian_byte_identical() {
        // The crate ships de/en/es/fr/hi/ja/zh taggers and no ru, so `--itn` is
        // inert on Russian rather than damaging (#710 open question).
        for ru in [
            "проверь все свои конфиги",
            "не нужно слать сообщения в телеграм",
            "у меня двадцать три сообщения",
            "закоммить изменения в гит",
        ] {
            assert_eq!(normalize_text(ru), ru);
        }
    }

    #[test]
    fn normalizes_english_inside_mixed_script_text() {
        assert_eq!(normalize_text("hello мир two hundred"), "hello мир 200");
    }

    #[test]
    fn preserves_segment_timing_and_count() {
        let before = vec![
            segment(
                0.0,
                1.5,
                "there are two hundred thirty two open pull requests",
            ),
            segment(2.0, 3.25, "закоммить изменения в гит"),
            segment(4.0, 5.5, "nothing to rewrite here"),
        ];
        let out = normalize_output(TranscriptionOutput {
            text: join_segment_texts(&before),
            segments: before.clone(),
        });

        assert_eq!(out.segments.len(), before.len());
        for (after, original) in out.segments.iter().zip(&before) {
            assert_eq!(after.start, original.start);
            assert_eq!(after.end, original.end);
        }
        assert_eq!(out.segments[0].text, "there are 232 open pull requests");
        assert_eq!(out.segments[1].text, before[1].text);
        assert_eq!(out.segments[2].text, before[2].text);
    }

    #[test]
    fn transcript_is_rebuilt_from_segments() {
        let out = normalize_output(TranscriptionOutput {
            text: "stale transcript that should be replaced".into(),
            segments: vec![
                segment(0.0, 1.0, "forty two"),
                segment(1.0, 2.0, "tests passed"),
            ],
        });
        assert_eq!(out.text, "42 tests passed");
        assert_eq!(out.text, join_segment_texts(&out.segments));
    }

    #[test]
    fn speaker_labels_survive_the_pass() {
        let mut labelled = segment(0.0, 1.0, "forty two");
        labelled.speaker = Some(3);
        let out = normalize_output(TranscriptionOutput {
            text: "forty two".into(),
            segments: vec![labelled],
        });
        assert_eq!(out.segments[0].speaker, Some(3));
    }

    #[test]
    fn blank_input_stays_blank() {
        let empty = normalize_output(TranscriptionOutput {
            text: String::new(),
            segments: vec![],
        });
        assert_eq!(empty.text, "");
        // `normalize_sentence` trims, so whitespace-only collapses to empty.
        // That is not content loss; the guard below is what protects content.
        assert_eq!(normalize_text("   "), "");
    }

    /// The pass rewrites content but re-tokenizes whitespace, so "unchanged"
    /// is only true word-for-word — the spec says content-preserving for this
    /// reason rather than byte-identical.
    #[test]
    fn text_without_numbers_keeps_its_words_but_may_lose_spacing() {
        assert_eq!(normalize_text("  hello   world "), "hello world");
        assert_eq!(normalize_text("no numbers here"), "no numbers here");
    }

    #[test]
    fn the_pass_is_idempotent() {
        for text in [
            "there are two hundred thirty two open pull requests",
            "it costs five dollars and fifty cents",
            "проверь все свои конфиги",
            "у меня двадцать три сообщения",
            "hello мир two hundred",
            "nothing to rewrite here",
            "the period of growth was remarkable",
            "she gave a plus one",
            "it was a difficult period.",
            "go to example dot com",
        ] {
            let once = normalize_text(text);
            assert_eq!(normalize_text(&once), once, "not idempotent for {text:?}");
        }

        let once = normalize_output(TranscriptionOutput {
            text: "forty two tests passed".into(),
            segments: vec![
                segment(0.0, 1.0, "forty two"),
                segment(1.0, 2.0, "tests passed"),
            ],
        });
        let twice = normalize_output(once.clone());
        assert_eq!(twice.text, once.text);
        assert_eq!(
            twice.segments.iter().map(|s| &s.text).collect::<Vec<_>>(),
            once.segments.iter().map(|s| &s.text).collect::<Vec<_>>()
        );
    }

    #[test]
    fn punctuation_names_stay_words_in_prose() {
        // #822: the upstream pass rewrites a bare punctuation name into its
        // symbol wherever it appears, so ordinary nouns lost their word.
        assert_eq!(
            normalize_text("the period of growth was remarkable"),
            "the period of growth was remarkable"
        );
        assert_eq!(
            normalize_text("the dash between them"),
            "the dash between them"
        );
        assert_eq!(normalize_text("put a comma there"), "put a comma there");
        assert_eq!(normalize_text("she gave a plus one"), "she gave a plus 1");
    }

    fn protected_names() -> impl Iterator<Item = &'static str> {
        PUNCTUATION_NAME_PAIRS
            .iter()
            .chain(PUNCTUATION_NAMES)
            .copied()
    }

    #[test]
    fn every_protected_name_survives_as_a_noun() {
        for name in protected_names() {
            let sentence = format!("the {name} of it");
            assert_eq!(normalize_text(&sentence), sentence);
        }
    }

    #[test]
    fn every_protected_name_is_one_upstream_would_rewrite() {
        // Keeps the list grounded in upstream's vocabulary rather than
        // guesswork, and fails loudly if a pin bump drops a name.
        for name in protected_names() {
            assert_ne!(
                text_processing_rs::normalize_sentence(name),
                name,
                "{name} is not upstream punctuation vocabulary"
            );
        }
    }

    #[test]
    fn punctuation_names_keep_their_sentence_punctuation() {
        assert_eq!(
            normalize_text("it was a difficult period."),
            "it was a difficult period."
        );
        assert_eq!(
            normalize_text("she asked a question mark, then left"),
            "she asked a question mark, then left"
        );
    }

    #[test]
    fn punctuation_names_are_guarded_on_the_segment_path() {
        let out = normalize_output(TranscriptionOutput {
            text: "stale".into(),
            segments: vec![
                segment(0.0, 1.0, "the period of growth"),
                segment(1.0, 2.0, "was remarkable"),
            ],
        });
        assert_eq!(out.segments[0].text, "the period of growth");
        assert_eq!(out.text, "the period of growth was remarkable");
    }

    /// Deliberate cost of the guard (#822): spoken identifiers and arithmetic
    /// that upstream assembled out of a punctuation name now stay literal.
    #[test]
    fn spoken_identifiers_keep_their_punctuation_names() {
        assert_eq!(
            normalize_text("go to example dot com"),
            "go to example dot com"
        );
        assert_eq!(
            normalize_text("two plus two equals four"),
            "2 plus 2 equals 4"
        );
    }

    #[test]
    fn text_is_kept_when_normalization_would_erase_it() {
        // Guards the one shape that would be data loss: non-blank in, blank out.
        for text in ["ok", "hello world", "проверь все свои конфиги"] {
            assert!(!normalize_text(text).trim().is_empty(), "{text} was erased");
        }
    }
}
