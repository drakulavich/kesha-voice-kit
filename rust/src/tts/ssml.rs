//! SSML → linear segment list for the TTS pipeline.
//!
//! Supported tags:
//! - `<speak>` — required root wrapper
//! - `<break time="...">` — silence of the given duration
//! - `<phoneme alphabet="ipa" ph="...">text</phoneme>` — bypass G2P and
//!   feed the IPA in `ph` directly to the synthesis tokenizer. Content
//!   text (`text` above) is suppressed. `alphabet` defaults to IPA when
//!   omitted; other values warn-strip with the inner text preserved.
//! - plain text inside/between elements — synthesized via G2P
//! - unknown tags — one stderr warning per name, contained text preserved

use std::collections::HashSet;
use std::time::Duration;

use ssml_parser::elements::{ParsedElement, PhonemeAlphabet};
use ssml_parser::parse_ssml;

/// A linearized slice of an SSML document.
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    /// Plain text to feed into the G2P → engine pipeline.
    Text(String),
    /// Pre-phonemized IPA (from a `<phoneme>` override). Bypasses G2P —
    /// the tokenizer receives the `ph` string verbatim.
    Ipa(String),
    /// Silence of the given duration.
    Break(Duration),
    /// Letter-by-letter spelling request from `<say-as interpret-as="characters">`.
    /// The Russian-Vosk normalization step expands this to a `Text` segment via
    /// `tts::ru::letter_table::expand_chars`. Other engines pass it through as text
    /// (their G2P will read the cyrillic word verbatim — acceptable until per-engine
    /// support lands).
    // Parser wiring lands in Task 2; normalization in Task 6 (#232). The variant
    // must exist now so mod.rs match arms are exhaustive — suppress until wired.
    #[allow(dead_code)]
    Spell(String),
}

/// Default `<break/>` duration when the `time` attribute is omitted.
/// Matches SSML 1.1's "medium" strength interpretation in most engines.
const DEFAULT_BREAK: Duration = Duration::from_millis(250);

/// Parse an SSML string into a linear segment list.
/// Unknown tags emit a single stderr warning per name and are otherwise stripped
/// (their text content is still synthesized).
///
/// Hardening: requires a `<speak>` root element, rejects `<!DOCTYPE>` (XXE surface),
/// and upstream `ssml-parser` disallows external entities by construction.
pub fn parse(input: &str) -> anyhow::Result<Vec<Segment>> {
    let trimmed = input.trim_start();
    if trimmed.is_empty() {
        anyhow::bail!("SSML input is empty");
    }
    if !trimmed.starts_with("<speak") {
        anyhow::bail!(
            "SSML must start with a <speak> element (got '{}...')",
            &trimmed.chars().take(20).collect::<String>()
        );
    }
    // Reject DOCTYPE declarations anywhere in the document — defense in depth
    // against billion-laughs / XXE, even though ssml-parser doesn't currently
    // expand external entities. Input length is already bounded upstream
    // (`MAX_TEXT_CHARS`), so a full scan is cheap.
    if contains_doctype(trimmed) {
        anyhow::bail!("SSML DOCTYPE declarations are not supported");
    }

    let ssml = parse_ssml(input)?;
    let text: Vec<char> = ssml.get_text().chars().collect();

    // Collect all spans + sort by start. The iterator order isn't guaranteed to be textual.
    let mut spans: Vec<_> = ssml.tags().collect();
    spans.sort_by_key(|s| s.start);

    let mut segments: Vec<Segment> = Vec::new();
    let mut warned: HashSet<String> = HashSet::new();
    let mut cursor: usize = 0;

    for span in &spans {
        match &span.element {
            // `<speak>` covers the whole document; nothing to emit for the wrapper itself.
            ParsedElement::Speak(_) => {}
            ParsedElement::Break(attrs) => {
                push_text_slice(&mut segments, &text, cursor, span.start);
                let dur = attrs
                    .time
                    .as_ref()
                    .map(|t| t.duration())
                    .unwrap_or(DEFAULT_BREAK);
                segments.push(Segment::Break(dur));
                cursor = span.end;
            }
            ParsedElement::Phoneme(attrs) => {
                // IPA override bypasses G2P. Alphabets other than `ipa`
                // warn-strip (contained text still flows as a Text segment),
                // so we only consume the span when the alphabet is IPA or
                // absent (the spec's implementation-defined default, which
                // we choose to be IPA since that's the only alphabet both
                // Kokoro's tokenizer and Piper's phoneme-id map speak).
                let is_ipa = matches!(&attrs.alphabet, None | Some(PhonemeAlphabet::Ipa));
                if is_ipa {
                    push_text_slice(&mut segments, &text, cursor, span.start);
                    if !attrs.ph.is_empty() {
                        segments.push(Segment::Ipa(attrs.ph.clone()));
                    }
                    cursor = span.end;
                } else {
                    // `is_ipa` above already filtered `None` and `Some(Ipa)`,
                    // so the only remaining variant today is `Other(s)`. Future
                    // `ssml-parser` enum growth falls into the wildcard with a
                    // synthesized name — warn + strip, never panic on user input.
                    let alpha = match &attrs.alphabet {
                        Some(PhonemeAlphabet::Other(s)) => s.clone(),
                        other => format!("{other:?}"),
                    };
                    if warned.insert(format!("phoneme[alphabet={alpha}]")) {
                        eprintln!(
                            "warning: SSML <phoneme alphabet=\"{alpha}\"> not supported — only \"ipa\" is recognised; falling back to G2P on contained text"
                        );
                    }
                }
            }
            other => {
                let name = tag_name(other);
                if warned.insert(name.clone()) {
                    eprintln!("warning: SSML tag <{name}> is not supported — stripping");
                }
                // Preserve the text content; don't touch cursor.
            }
        }
    }
    // Trailing text after the last span.
    push_text_slice(&mut segments, &text, cursor, text.len());
    Ok(segments)
}

fn push_text_slice(out: &mut Vec<Segment>, text: &[char], start: usize, end: usize) {
    if start >= end {
        return;
    }
    let chunk: String = text[start..end].iter().collect();
    if !chunk.trim().is_empty() {
        out.push(Segment::Text(chunk));
    }
}

fn tag_name(el: &ParsedElement) -> String {
    // Explicit map to the canonical SSML element name. Using Debug would produce
    // `sayas` for `<say-as>` and `description` for `<desc>` — user-facing warnings
    // need to match the tag the user typed.
    let name = match el {
        ParsedElement::Speak(_) => "speak",
        ParsedElement::Lexicon(_) => "lexicon",
        ParsedElement::Lookup(_) => "lookup",
        ParsedElement::Meta(_) => "meta",
        ParsedElement::Metadata => "metadata",
        ParsedElement::Paragraph => "p",
        ParsedElement::Sentence => "s",
        ParsedElement::Token(_) => "token",
        ParsedElement::Word(_) => "w",
        ParsedElement::SayAs(_) => "say-as",
        // Canonical name kept for exhaustiveness; `parse()` handles Phoneme directly.
        ParsedElement::Phoneme(_) => "phoneme",
        ParsedElement::Sub(_) => "sub",
        ParsedElement::Lang(_) => "lang",
        ParsedElement::Voice(_) => "voice",
        ParsedElement::Emphasis(_) => "emphasis",
        ParsedElement::Break(_) => "break",
        ParsedElement::Prosody(_) => "prosody",
        ParsedElement::Audio(_) => "audio",
        ParsedElement::Mark(_) => "mark",
        ParsedElement::Description(_) => "desc",
        ParsedElement::Custom((name, _)) => return name.to_ascii_lowercase(),
    };
    name.to_string()
}

/// Case-insensitive search for `<!DOCTYPE` anywhere in the input.
fn contains_doctype(input: &str) -> bool {
    const NEEDLE: &[u8] = b"<!DOCTYPE";
    let bytes = input.as_bytes();
    if bytes.len() < NEEDLE.len() {
        return false;
    }
    bytes
        .windows(NEEDLE.len())
        .any(|w| w.eq_ignore_ascii_case(NEEDLE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_in_speak_produces_single_text_segment() {
        let segs = parse("<speak>Hello, world</speak>").unwrap();
        assert_eq!(segs.len(), 1);
        match &segs[0] {
            Segment::Text(s) => assert!(s.contains("Hello"), "got {s:?}"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn break_with_time_produces_silence_segment() {
        let segs = parse(r#"<speak>Hello <break time="500ms"/> world</speak>"#).unwrap();
        let mut text_chunks = 0;
        let mut breaks = 0;
        for s in &segs {
            match s {
                Segment::Text(_) => text_chunks += 1,
                Segment::Ipa(_) => panic!("unexpected Ipa segment"),
                Segment::Spell(_) => panic!("unexpected Spell segment"),
                Segment::Break(d) => {
                    assert_eq!(*d, Duration::from_millis(500));
                    breaks += 1;
                }
            }
        }
        assert_eq!(text_chunks, 2, "expected two text chunks, got {segs:?}");
        assert_eq!(breaks, 1);
    }

    #[test]
    fn break_with_seconds_parses_correctly() {
        let segs = parse(r#"<speak>A <break time="2s"/> B</speak>"#).unwrap();
        let break_durs: Vec<Duration> = segs
            .iter()
            .filter_map(|s| match s {
                Segment::Break(d) => Some(*d),
                _ => None,
            })
            .collect();
        assert_eq!(break_durs, vec![Duration::from_secs(2)]);
    }

    #[test]
    fn break_without_time_uses_default() {
        let segs = parse(r#"<speak>A <break/> B</speak>"#).unwrap();
        let has_default = segs
            .iter()
            .any(|s| matches!(s, Segment::Break(d) if *d == DEFAULT_BREAK));
        assert!(has_default, "expected default break, got {segs:?}");
    }

    #[test]
    fn unknown_tag_is_stripped_with_warning() {
        // <emphasis> is in our non-goal list for v1 — should warn + strip, preserve text.
        let segs = parse(r#"<speak>Hi <emphasis>there</emphasis></speak>"#).unwrap();
        let all_text: String = segs
            .iter()
            .filter_map(|s| match s {
                Segment::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        assert!(all_text.contains("Hi"));
        assert!(all_text.contains("there"));
    }

    #[test]
    fn input_without_speak_root_errors() {
        let err = parse("not xml").unwrap_err();
        assert!(err.to_string().contains("<speak>"), "msg: {err}");
    }

    #[test]
    fn empty_input_errors() {
        assert!(parse("").unwrap_err().to_string().contains("empty"));
        assert!(parse("   \n  ").unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn doctype_is_rejected() {
        let input = r#"<!DOCTYPE speak SYSTEM "foo"><speak>Hi</speak>"#;
        // DOCTYPE before <speak> → fails the <speak> root check first (still rejected)
        assert!(parse(input).is_err());
    }

    #[test]
    fn doctype_inside_speak_is_rejected() {
        let input = "<speak><!DOCTYPE foo>Hi</speak>";
        let err = parse(input).unwrap_err();
        assert!(err.to_string().contains("DOCTYPE"), "msg: {err}");
    }

    #[test]
    fn malformed_break_attribute_errors() {
        // Invalid time designation (not "Ns" or "Nms") → upstream parser rejects.
        let input = r#"<speak><break time="abc"/></speak>"#;
        assert!(parse(input).is_err());
    }

    #[test]
    fn doctype_deep_in_document_is_rejected() {
        // DOCTYPE past a 256-char prefix — earlier implementation had a scan window.
        let filler = "a ".repeat(400);
        let input = format!("<speak>{filler}<!DOCTYPE evil>tail</speak>");
        let err = parse(&input).unwrap_err();
        assert!(err.to_string().contains("DOCTYPE"), "msg: {err}");
    }

    #[test]
    fn say_as_tag_warning_uses_hyphenated_name() {
        // Regression: earlier Debug-based tag_name() produced `sayas`.
        use ssml_parser::elements::SayAsAttributes;
        let el = ParsedElement::SayAs(SayAsAttributes {
            interpret_as: "characters".to_string(),
            format: None,
            detail: None,
        });
        assert_eq!(tag_name(&el), "say-as");
    }

    #[test]
    fn phoneme_with_ipa_alphabet_emits_ipa_segment_and_suppresses_inner_text() {
        let segs = parse(
            r#"<speak>He said <phoneme alphabet="ipa" ph="nuˈmoʊniə">pneumonia</phoneme>.</speak>"#,
        )
        .unwrap();
        let ipas: Vec<&str> = segs
            .iter()
            .filter_map(|s| match s {
                Segment::Ipa(p) => Some(p.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ipas, vec!["nuˈmoʊniə"]);
        // The inner "pneumonia" text must NOT leak into a Text segment —
        // that would double-speak the word (Kokoro would G2P it too).
        let all_text: String = segs
            .iter()
            .filter_map(|s| match s {
                Segment::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            !all_text.contains("pneumonia"),
            "inner text leaked: {all_text:?}"
        );
        assert!(
            all_text.contains("He said"),
            "outer text missing: {all_text:?}"
        );
    }

    #[test]
    fn phoneme_without_alphabet_defaults_to_ipa() {
        let segs = parse(r#"<speak><phoneme ph="həˈloʊ">hello</phoneme></speak>"#).unwrap();
        assert!(segs
            .iter()
            .any(|s| matches!(s, Segment::Ipa(p) if p == "həˈloʊ")));
    }

    #[test]
    fn phoneme_with_non_ipa_alphabet_falls_back_to_text() {
        let segs =
            parse(r#"<speak><phoneme alphabet="x-sampa" ph="h@_'low">hello</phoneme></speak>"#)
                .unwrap();
        // Non-IPA warn-strips: inner text flows as a Text segment so the
        // content still gets synthesized via G2P rather than dropped.
        assert!(segs.iter().all(|s| !matches!(s, Segment::Ipa(_))));
        assert!(segs
            .iter()
            .any(|s| matches!(s, Segment::Text(t) if t.contains("hello"))));
    }

    #[test]
    fn phoneme_with_empty_ph_is_dropped_silently() {
        let segs = parse(r#"<speak>pre <phoneme ph="">hello</phoneme> post</speak>"#).unwrap();
        assert!(segs.iter().all(|s| !matches!(s, Segment::Ipa(_))));
        let all_text: String = segs
            .iter()
            .filter_map(|s| match s {
                Segment::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            !all_text.contains("hello"),
            "inner text leaked when ph is empty: {all_text:?}"
        );
    }

    #[test]
    fn multiple_breaks_produce_multiple_silence_segments() {
        let segs =
            parse(r#"<speak>A <break time="100ms"/> B <break time="200ms"/> C</speak>"#).unwrap();
        let break_ms: Vec<u64> = segs
            .iter()
            .filter_map(|s| match s {
                Segment::Break(d) => Some(d.as_millis() as u64),
                _ => None,
            })
            .collect();
        // ssml-parser converts via f32 → Duration, so allow ±1ms slop per break.
        assert_eq!(break_ms.len(), 2, "got {break_ms:?}");
        assert!(
            (99..=101).contains(&break_ms[0]) && (199..=201).contains(&break_ms[1]),
            "breaks out of tolerance: {break_ms:?}"
        );
    }

    #[test]
    fn segment_has_spell_variant() {
        // Ensure the variant exists and is constructible. Parser wiring lands in Task 2.
        let s = Segment::Spell("ВОЗ".to_string());
        match s {
            Segment::Spell(t) => assert_eq!(t, "ВОЗ"),
            _ => panic!("expected Segment::Spell"),
        }
    }
}
