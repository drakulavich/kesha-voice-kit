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
        let normalized = normalize_text(&segment.text);
        // Rewriting "thirty two" as "32" leaves the word timings describing
        // words the text no longer contains; absent beats misaligned (#720).
        if normalized != segment.text {
            segment.words = None;
        }
        segment.text = normalized;
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

/// Upstream's `SCALES` at the `8a043f1` pin: after one of these an "and" can
/// still belong to the number ("three hundred and five") rather than to the
/// sentence (#1000).
const NUMBER_SCALE_WORDS: &[&str] = &[
    "hundred",
    "thousand",
    "million",
    "billion",
    "trillion",
    "quadrillion",
    "quintillion",
    "sextillion",
    "lakh",
    "crore",
];

/// The other head whose "and" can belong to the number, but only when a cents
/// phrase follows, because it is `parse_dollars_and_cents`' split rather than
/// a scale ("five dollars and fifty cents").
const DOLLAR_HEADS: &[&str] = &["dollar", "dollars"];

/// Upstream's 0-99 vocabulary (`ONES` + `TENS`) — the only words that can
/// complete a number after a connector.
const NUMBER_TAIL_WORDS: &[&str] = &[
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
];

/// The only whitelist entry containing "and" (`itn/en/whitelist.rs` at the
/// `8a043f1` pin). Masking that "and" would hide `S&P 500` from the whitelist,
/// so the phrase is matched as a whole and left intact (#1000).
const WHITELIST_AND_PHRASE: &[&str] = &["s", "and", "p", "five", "hundred"];

/// Object-replacement character: no upstream tagger matches a span containing
/// it, and the pretokenizer neither splits nor absorbs it.
const PROTECTED_MASK: &str = "\u{FFFC}";

/// `normalize_sentence` trims its input and can return an empty string for
/// whitespace-only text; keep the original in that case so the pass can only
/// ever rewrite content, never erase it.
fn normalize_text(text: &str) -> String {
    let masked = prepare_for_upstream(text);
    let source = masked.as_ref().map_or(text, |(masked, _)| masked.as_str());
    let normalized = text_processing_rs::normalize_sentence(source);
    let normalized = match &masked {
        Some((_, names)) => match restore_protected_words(&normalized, names) {
            Some(restored) => restored,
            None => {
                eprintln!(
                    "warning: --itn left a segment unnormalized: the text pass returned {} of {} protected-word placeholders, \
                     so the pinned text-processing-rs revision no longer treats U+FFFC as inert. Report this against #822.",
                    normalized.matches(PROTECTED_MASK).count(),
                    names.len()
                );
                return text.to_string();
            }
        },
        None => normalized,
    };
    if normalized.trim().is_empty() && !text.trim().is_empty() {
        return text.to_string();
    }
    normalized
}

/// Rewrite the text into the form upstream reads correctly: every word it
/// would consume out from under the speaker replaced with [`PROTECTED_MASK`]
/// (#822, #1000), hyphenated numbers spaced out (#1004) and the "and" that
/// splits a number dropped (#1006). Returns the rewritten text and the masked
/// words in order, or `None` when nothing needed changing so untouched text
/// reaches upstream byte-identical.
fn prepare_for_upstream(text: &str) -> Option<(String, Vec<String>)> {
    if text.contains(PROTECTED_MASK) {
        return None;
    }
    let mut words: Vec<&str> = Vec::new();
    let mut rewritten = false;
    for token in text.split_whitespace() {
        rewritten |= split_hyphenated_number(token, &mut words);
    }
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
            masked.push(PROTECTED_MASK);
            i += 2;
        } else if PUNCTUATION_NAMES.contains(&core.as_str())
            || (core == "and" && !joins_a_number(&words, i) && !starts_whitelist_phrase(&words, i))
        {
            names.push(words[i].to_string());
            masked.push(PROTECTED_MASK);
            i += 1;
        } else if core == "and" && a_scale_owns_the_and(&words, i) {
            rewritten = true;
            i += 1;
        } else {
            masked.push(words[i]);
            i += 1;
        }
    }
    if names.is_empty() && !rewritten {
        return None;
    }
    Some((masked.join(" "), names))
}

/// Upstream's pretokenizer does not split on "-", so `twenty-five` matches no
/// cardinal word and stays spelled out. Only a token whose every part is a
/// number word is spaced out, so `well-known` and `twenty-something` keep
/// their hyphen (#1004). True when the token was split.
fn split_hyphenated_number<'a>(token: &'a str, out: &mut Vec<&'a str>) -> bool {
    let splittable = token.contains('-')
        && token
            .split('-')
            .all(|part| is_number_word(&punctuation_core(part)));
    if splittable {
        out.extend(token.split('-'));
    } else {
        out.push(token);
    }
    splittable
}

fn is_number_word(core: &str) -> bool {
    NUMBER_TAIL_WORDS.contains(&core) || NUMBER_SCALE_WORDS.contains(&core)
}

/// Upstream's cardinal fallback spans at most four tokens (`parse_span`), so a
/// scale word's "and" pushes "two hundred and thirty two" past the limit and
/// two shorter spans win instead — 230, then 2. Dropping that "and" before the
/// pass makes the number one span again; the money tagger's "and" is left in
/// place because `parse_dollars_and_cents` reads it (#1006).
fn a_scale_owns_the_and(words: &[&str], and_index: usize) -> bool {
    joins_a_number(words, and_index)
        && and_index.checked_sub(1).is_some_and(|head| {
            NUMBER_SCALE_WORDS.contains(&punctuation_core(words[head]).as_str())
        })
}

/// Upstream's cardinal reader strips a bare "and" from every span it takes, so
/// a sentence "and" next to a spoken number is swallowed with it (#1000).
/// English only puts "and" inside a number between a connector head and a word
/// that completes it, so every other "and" is the speaker's and gets masked.
fn joins_a_number(words: &[&str], and_index: usize) -> bool {
    let (Some(before), Some(after)) = (
        and_index.checked_sub(1).map(|p| words[p]),
        words.get(and_index + 1),
    ) else {
        return false;
    };
    // "two thousand, and three apples": the clause break ended the number.
    if before.ends_with(|c: char| c.is_ascii_punctuation()) {
        return false;
    }
    let head = punctuation_core(before);
    if !(NUMBER_SCALE_WORDS.contains(&head.as_str()) || DOLLAR_HEADS.contains(&head.as_str()))
        || !NUMBER_TAIL_WORDS.contains(&punctuation_core(after).as_str())
    {
        return false;
    }
    // A whole dollar amount is a complete number, so what follows its "and" is
    // the number's only when it is the cents half of the money tagger's split;
    // "five dollars and three apples" is the speaker's conjunction (#1000).
    if DOLLAR_HEADS.contains(&head.as_str()) {
        let cents = words[and_index + 1..]
            .iter()
            .take_while(|word| NUMBER_TAIL_WORDS.contains(&punctuation_core(word).as_str()))
            .count();
        return words[and_index + 1 + cents..]
            .first()
            .is_none_or(|rest| matches!(punctuation_core(rest).as_str(), "cent" | "cents"));
    }
    true
}

/// True when the "and" at `and_index` sits inside [`WHITELIST_AND_PHRASE`].
fn starts_whitelist_phrase(words: &[&str], and_index: usize) -> bool {
    let Some(start) = and_index.checked_sub(1) else {
        return false;
    };
    words
        .get(start..start + WHITELIST_AND_PHRASE.len())
        .is_some_and(|window| {
            window
                .iter()
                .zip(WHITELIST_AND_PHRASE)
                .all(|(word, expected)| punctuation_core(word) == *expected)
        })
}

fn punctuation_core(word: &str) -> String {
    word.trim_matches(|c: char| c.is_ascii_punctuation())
        .to_lowercase()
}

/// All-or-nothing: `None` unless every placeholder is matched by exactly one
/// saved name, so a pin that eats or splits the mask fails closed rather than
/// shifting every later name onto the wrong slot.
fn restore_protected_words(text: &str, names: &[String]) -> Option<String> {
    let mut names = names.iter();
    let mut out = String::with_capacity(text.len());
    for (index, part) in text.split(PROTECTED_MASK).enumerate() {
        if index > 0 {
            out.push_str(names.next()?);
        }
        out.push_str(part);
    }
    names.next().is_none().then_some(out)
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
            words: None,
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

    /// "thirty two" → "32" leaves word timings naming words the text no longer
    /// has. Dropping them is honest; keeping them would silently misalign (#720).
    #[test]
    fn drops_word_timings_only_from_segments_it_rewrote() {
        let with_words = |start, end, text: &str| TranscriptionSegment {
            words: Some(
                text.split_whitespace()
                    .enumerate()
                    .map(|(i, w)| crate::transcribe::WordTiming {
                        word: w.to_string(),
                        start: start + i as f32 * 0.1,
                        end: start + i as f32 * 0.1 + 0.1,
                    })
                    .collect(),
            ),
            ..segment(start, end, text)
        };
        let out = normalize_output(TranscriptionOutput {
            text: String::new(),
            segments: vec![
                with_words(0.0, 1.5, "we merged forty two patches"),
                with_words(2.0, 3.0, "nothing to rewrite here"),
            ],
        });

        assert_eq!(out.segments[0].text, "we merged 42 patches");
        assert!(out.segments[0].words.is_none());
        assert_eq!(
            out.segments[1]
                .words
                .as_ref()
                .map(|w| w.len())
                .unwrap_or_default(),
            4,
            "an untouched segment keeps its words"
        );
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
            "Cats and three dogs.",
            "Three hundred and five dogs.",
            "five dollars and three apples",
            "two thousand, and three apples",
            "the s and p five hundred index",
            "two hundred and thirty two open pull requests",
            "twenty-five apples",
            "a well-known bug",
            "state-of-the-art tooling",
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

    /// Deliberate cost of the guard (#822): identifiers, arithmetic and units
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
        assert_eq!(
            normalize_text("revenue grew twenty percent"),
            "revenue grew 20 percent"
        );
    }

    #[test]
    fn the_guard_ignores_case() {
        assert_eq!(normalize_text("Period of growth"), "Period of growth");
        assert_eq!(
            normalize_text("the PERIOD of growth"),
            "the PERIOD of growth"
        );
        assert_eq!(
            normalize_text("a Question Mark appeared"),
            "a Question Mark appeared"
        );
    }

    #[test]
    fn adjacent_punctuation_names_each_keep_their_word() {
        assert_eq!(normalize_text("comma comma"), "comma comma");
        assert_eq!(
            normalize_text("the dash dash between them"),
            "the dash dash between them"
        );
    }

    #[test]
    fn a_punctuation_name_inside_mixed_script_text_is_guarded() {
        assert_eq!(
            normalize_text("hello мир the period of two hundred"),
            "hello мир the period of 200"
        );
    }

    #[test]
    fn restoring_is_all_or_nothing() {
        let names = vec!["period".to_string(), "comma".to_string()];
        assert_eq!(
            restore_protected_words("a \u{FFFC} b \u{FFFC} c", &names),
            Some("a period b comma c".to_string())
        );
        assert_eq!(restore_protected_words("a \u{FFFC} b", &names), None);
        assert_eq!(
            restore_protected_words("a \u{FFFC} b \u{FFFC} c \u{FFFC}", &names),
            None
        );
    }

    #[test]
    fn a_sentence_and_survives_a_number_that_follows_it() {
        // #1000: upstream's cardinal reader strips "and" from any span it
        // takes, so the speaker's conjunction vanished with the number.
        for (spoken, expected) in [
            ("Cats and three dogs.", "Cats and 3 dogs."),
            (
                "I have twenty-five apples and three hundred oranges.",
                "I have 25 apples and 300 oranges.",
            ),
            ("Cats and 300 dogs.", "Cats and 300 dogs."),
            ("Cats and 20 dogs.", "Cats and 20 dogs."),
            (
                "Bread and butter and cheese.",
                "Bread and butter and cheese.",
            ),
            ("and three dogs", "and 3 dogs"),
            (
                "salt and pepper and three eggs",
                "salt and pepper and 3 eggs",
            ),
            ("between five and ten dogs", "between 5 and 10 dogs"),
            ("pick one and two", "pick 1 and 2"),
            ("chapter five and three dogs", "chapter 5 and 3 dogs"),
            ("two and a half hours", "2 and a half hours"),
            // No word completes the number, so the "and" is the speaker's even
            // straight after a scale word.
            ("we counted three hundred and", "we counted 300 and"),
            ("three hundred and five and three dogs", "305 and 3 dogs"),
        ] {
            assert_eq!(normalize_text(spoken), expected);
        }
    }

    #[test]
    fn an_and_inside_a_number_still_joins_it() {
        for (spoken, expected) in [
            ("Three hundred and five dogs.", "305 dogs."),
            ("one thousand and one nights", "1001 nights"),
            ("it costs five dollars and fifty cents", "it costs $5.50"),
            ("fifty dollars and ninety nine cents", "$50.99"),
            ("one dollar and one cent", "$1.01"),
            ("five dollars and fifty", "$5.50"),
        ] {
            assert_eq!(normalize_text(spoken), expected);
        }
    }

    /// A whole dollar amount is already a complete number, so upstream's split
    /// only justifies eating the "and" when the cents half follows. Without
    /// this the tail became cents: `$5.03 apples`, `$10.02 tickets` (#1000).
    #[test]
    fn a_dollar_amount_keeps_an_and_no_cents_phrase_follows() {
        for (spoken, expected) in [
            ("five dollars and three apples", "$5 and 3 apples"),
            ("ten dollars and two tickets", "$10 and 2 tickets"),
            ("one dollar and two tickets", "$1 and 2 tickets"),
        ] {
            assert_eq!(normalize_text(spoken), expected);
        }
    }

    /// Punctuation on the connector ends the number, so the "and" after it
    /// starts a new clause and belongs to the speaker (#1000).
    #[test]
    fn a_clause_break_on_the_connector_releases_the_and() {
        for (spoken, expected) in [
            ("two thousand, and three apples", "2000, and 3 apples"),
            ("two thousand. and three apples", "2000. and 3 apples"),
        ] {
            assert_eq!(normalize_text(spoken), expected);
        }
    }

    /// `S&P 500` is upstream's one whitelist phrase built around an "and";
    /// masking it would leave the phrase untagged (#1000).
    #[test]
    fn the_whitelist_phrase_built_on_and_still_matches() {
        for (spoken, expected) in [
            ("s and p five hundred", "S&P 500"),
            ("the s and p five hundred index", "the S&P 500 index"),
            ("the S and P five hundred index", "the S&P 500 index"),
            // Too short to be the phrase, so the "and" is the speaker's again.
            ("s and p five", "s and p 5"),
        ] {
            assert_eq!(normalize_text(spoken), expected);
        }
    }

    #[test]
    fn the_whitelist_and_phrase_is_one_upstream_rewrites() {
        // Grounds the constant in upstream's own whitelist rather than
        // guesswork, and fails loudly if a pin bump drops or renames the entry.
        let phrase = WHITELIST_AND_PHRASE.join(" ");
        assert_eq!(text_processing_rs::normalize_sentence(&phrase), "S&P 500");
    }

    /// Upstream limits the rewrites do not reach, pinned so a pin bump shows up
    /// as a diff here rather than a surprise: a whitelist hit ends the pass so
    /// what follows it is never tagged, and a hyphenated number the split
    /// declines to touch is only half-read.
    #[test]
    fn upstream_limits_the_rewrites_do_not_reach() {
        assert_eq!(
            normalize_text("s and p five hundred and three dogs"),
            "S&P 500 three dogs"
        );
        assert_eq!(normalize_text("twenty-five thousand"), "25 thousand");
    }

    /// Both lists exist to name the one position where upstream is right to
    /// eat the "and". Keeps them grounded in upstream's own vocabulary rather
    /// than guesswork, and fails loudly if a pin bump moves that position.
    #[test]
    fn upstream_absorbs_the_and_at_every_position_the_rule_exempts() {
        let absorbs_and = |phrase: &str| {
            !text_processing_rs::normalize_sentence(phrase)
                .split_whitespace()
                .any(|word| word == "and")
        };
        for head in NUMBER_SCALE_WORDS.iter().chain(DOLLAR_HEADS) {
            let phrase = format!("two {head} and one");
            assert!(absorbs_and(&phrase), "{head} is not a number connector");
        }
        for tail in NUMBER_TAIL_WORDS {
            let phrase = format!("two hundred and {tail}");
            assert!(absorbs_and(&phrase), "{tail} does not complete a number");
        }
    }

    /// #1006: upstream's cardinal fallback spans at most four tokens, so the
    /// "and" a scale word owns pushed the number past the limit and it resolved
    /// as two — "two hundred and thirty two" came out "230 2".
    #[test]
    fn an_and_a_scale_owns_does_not_split_the_number() {
        for (spoken, expected) in [
            ("two hundred and thirty two", "232"),
            (
                "there are two hundred and thirty two open pull requests",
                "there are 232 open pull requests",
            ),
            ("five hundred and twenty three dogs", "523 dogs"),
            ("one hundred and twenty five", "125"),
            // Already one span before the collapse, and still one after it.
            ("two hundred thirty two", "232"),
            ("one thousand two hundred thirty four", "1234"),
        ] {
            assert_eq!(normalize_text(spoken), expected, "{spoken:?}");
        }
    }

    /// The collapse (#1006) and the sentence-"and" mask (#1000) act on different
    /// "and"s in the same pass and must not trade places: the speaker's survives,
    /// the number's disappears into its number, the money tagger's stays put.
    #[test]
    fn the_collapse_composes_with_the_sentence_and_mask() {
        for (spoken, expected) in [
            ("cats and three dogs", "cats and 3 dogs"),
            ("three hundred and five dogs", "305 dogs"),
            (
                "two hundred and thirty two open pull requests and cats",
                "232 open pull requests and cats",
            ),
            ("it costs five dollars and fifty cents", "it costs $5.50"),
            ("five dollars and three apples", "$5 and 3 apples"),
            ("the s and p five hundred index", "the S&P 500 index"),
            ("we counted three hundred and", "we counted 300 and"),
            ("two thousand, and three apples", "2000, and 3 apples"),
        ] {
            assert_eq!(normalize_text(spoken), expected, "{spoken:?}");
        }
    }

    /// #1004: upstream's pretokenizer does not split on "-", so a hyphenated
    /// number matched no cardinal word and stayed spelled out.
    #[test]
    fn a_hyphenated_number_is_rewritten_like_the_spaced_form() {
        for (spoken, expected) in [
            ("twenty-five apples", "25 apples"),
            ("twenty five apples", "25 apples"),
            ("nineteen eighty-four", "1984"),
            ("one hundred and twenty-five", "125"),
            ("twenty-five, apples", "25, apples"),
            ("the number two-hundred", "the number 200"),
            (
                "I have twenty-five apples and three hundred oranges.",
                "I have 25 apples and 300 oranges.",
            ),
        ] {
            assert_eq!(normalize_text(spoken), expected, "{spoken:?}");
        }
    }

    /// The split fires only when every hyphen-separated part is a number word,
    /// so an ordinary hyphenated word keeps its hyphen (#1004).
    #[test]
    fn a_hyphen_between_non_number_words_survives() {
        for text in [
            "a well-known bug",
            "state-of-the-art tooling",
            "twenty-something developers",
            "a T-shirt",
            "the twenty-first commit",
            "a two-thirds majority",
            "a nine-to-five job",
            "merge-base",
            "re-run it",
            "over-engineered",
        ] {
            assert_eq!(normalize_text(text), text, "{text:?}");
        }
    }

    #[test]
    fn text_is_kept_when_normalization_would_erase_it() {
        // Guards the one shape that would be data loss: non-blank in, blank out.
        for text in ["ok", "hello world", "проверь все свои конфиги"] {
            assert!(!normalize_text(text).trim().is_empty(), "{text} was erased");
        }
    }
}
