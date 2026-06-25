use std::time::Duration;

/// A linearized slice of an SSML document.
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    /// Plain text to feed into the G2P → engine pipeline.
    Text(String),
    /// Pre-phonemized IPA (from a `<phoneme>` override). Bypasses G2P.
    Ipa(String),
    Break(Duration),
    /// `<say-as interpret-as="characters">`. Vosk expands via `letter_table::expand_chars`;
    /// other engines receive it as text until per-engine support lands.
    Spell(String),
    /// `<emphasis>` content. Vosk honors `+vowel` stress markers (#233); other engines strip them.
    /// `suppress` (`level="none"`) forces stripping regardless of voice.
    Emphasis {
        content: String,
        suppress: bool,
    },
    /// `<prosody rate>` wrapping the full utterance. Dispatcher multiplies `rate` by `--rate`.
    /// Mid-utterance prosody is warned+stripped at parse time.
    ProsodyRate {
        rate: f32,
        content: Vec<Segment>,
    },
}

/// Default `<break/>` duration when the `time` attribute is omitted.
/// Matches SSML 1.1's "medium" strength interpretation in most engines.
pub(super) const DEFAULT_BREAK: Duration = Duration::from_millis(250);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_has_spell_variant() {
        let s = Segment::Spell("ВОЗ".to_string());
        match s {
            Segment::Spell(t) => assert_eq!(t, "ВОЗ"),
            _ => panic!("expected Segment::Spell"),
        }
    }

    #[test]
    fn segment_has_emphasis_variant() {
        let s = Segment::Emphasis {
            content: "д+ома".to_string(),
            suppress: false,
        };
        match s {
            Segment::Emphasis { content, suppress } => {
                assert_eq!(content, "д+ома");
                assert!(!suppress);
            }
            _ => panic!("expected Segment::Emphasis"),
        }
    }
}
