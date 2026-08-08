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

/// `normalize_sentence` trims its input and can return an empty string for
/// whitespace-only text; keep the original in that case so the pass can only
/// ever rewrite content, never erase it.
fn normalize_text(text: &str) -> String {
    let normalized = text_processing_rs::normalize_sentence(text);
    if normalized.trim().is_empty() && !text.trim().is_empty() {
        return text.to_string();
    }
    normalized
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

    #[test]
    fn text_is_kept_when_normalization_would_erase_it() {
        // Guards the one shape that would be data loss: non-blank in, blank out.
        for text in ["ok", "hello world", "проверь все свои конфиги"] {
            assert!(!normalize_text(text).trim().is_empty(), "{text} was erased");
        }
    }
}
