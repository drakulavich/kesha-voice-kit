//! SSML → linear segment list for the TTS pipeline.
//!
//! Supported tags:
//! - `<speak>` — required root wrapper
//! - `<break time="...">` — silence of the given duration
//! - `<phoneme alphabet="ipa" ph="...">text</phoneme>` — bypass G2P and
//!   feed the IPA in `ph` directly to the synthesis tokenizer. Content
//!   text (`text` above) is suppressed. `alphabet` defaults to IPA when
//!   omitted; other values warn-strip with the inner text preserved.
//! - `<emphasis level="...">text</emphasis>` — stress hint; `level="none"` sets
//!   `suppress=true` (strip `+` markers); all other levels preserve them for Vosk
//! - `<prosody rate="...">text</prosody>` — speed multiplier; only supported when
//!   the prosody wraps the entire utterance (immediate child of `<speak>` with no
//!   other meaningful content). Mid-utterance prosody is warned and stripped.
//! - plain text inside/between elements — synthesized via G2P
//! - unknown tags — one stderr warning per name, contained text preserved

mod rate;
mod segment;
mod walker;
mod warnings;

use ssml_parser::elements::ParsedElement;
use ssml_parser::parse_ssml;

use crate::coded_bail;
use crate::errors::ErrorCode;

pub use segment::Segment;

use super::warn::warn_once;
use rate::{find_relative_rate, has_structural_source_siblings, parse_rate_value};
use walker::{emit_span, parse_inner_spans, push_text_slice, span_priority};
use warnings::{WARN_PROSODY_MID_UTTERANCE, WARN_PROSODY_NO_SUPPORTED_ATTR};

/// Parse an SSML string into a linear segment list.
/// Unknown tags emit a single stderr warning per name and are otherwise stripped
/// (their text content is still synthesized).
///
/// Hardening: requires a `<speak>` root element, rejects `<!DOCTYPE>` (XXE surface),
/// and upstream `ssml-parser` disallows external entities by construction.
pub fn parse(input: &str) -> anyhow::Result<Vec<Segment>> {
    let trimmed = input.trim_start();
    if trimmed.is_empty() {
        coded_bail!(ErrorCode::SsmlInvalid, "SSML input is empty");
    }
    if !trimmed.starts_with("<speak") {
        coded_bail!(
            ErrorCode::SsmlInvalid,
            "SSML must start with a <speak> element (got '{}...')",
            &trimmed.chars().take(20).collect::<String>()
        );
    }
    // Defense in depth against XXE/billion-laughs; ssml-parser doesn't expand entities
    // but we reject DOCTYPE regardless. Input is bounded upstream so a full scan is cheap.
    if contains_doctype(trimmed) {
        coded_bail!(
            ErrorCode::SsmlInvalid,
            "SSML DOCTYPE declarations are not supported"
        );
    }
    // ssml-parser strips the `+` in `+25%` (Display gives `"25%"`), so we'd
    // silently treat relative `+25%` as absolute 0.25×. Reject early. (#236)
    if let Some(rel) = find_relative_rate(trimmed) {
        coded_bail!(
            ErrorCode::SsmlInvalid,
            "SSML <prosody rate=\"{rel}\"> uses a relative percentage; \
             this is not yet supported. Use an absolute percentage (e.g. \
             \"125%\") or a named value (\"x-slow\"/\"slow\"/\"medium\"/\
             \"fast\"/\"x-fast\"/\"default\") instead."
        );
    }

    let ssml = parse_ssml(input)?;
    let text: Vec<char> = ssml.get_text().chars().collect();

    // Secondary sort by priority so that when spans share the same `start`, inner
    // structural tags (Phoneme, SayAs) run before Emphasis and advance cursor first
    // — the cursor-guard below then skips the outer tag ("inner tag wins" spec rule).
    let mut spans: Vec<_> = ssml.tags().collect();
    spans.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| span_priority(&a.element).cmp(&span_priority(&b.element)))
    });

    // #560: ranges of whole-utterance <prosody rate> that recurse into parse_inner_spans.
    let recursed_prosody: Vec<(usize, usize)> = spans
        .iter()
        .filter_map(|s| match &s.element {
            ParsedElement::Prosody(attrs)
                if prosody_is_whole_utterance(s, &text, input)
                    && attrs
                        .rate
                        .as_ref()
                        .map(|r| r.to_string())
                        .as_deref()
                        .and_then(parse_rate_value)
                        .is_some() =>
            {
                Some((s.start, s.end))
            }
            _ => None,
        })
        .collect();

    let mut segments: Vec<Segment> = Vec::new();
    let mut cursor: usize = 0;

    for span in &spans {
        // Inner structural tag (priority 0) already consumed this region; skip outer. (#233)
        if span.start < cursor {
            continue;
        }
        // #560: a zero-width <break/> at a recursing-prosody boundary escapes the
        // cursor guard above (start == end) and would emit flat here AND inside the
        // ProsodyRate; skip it (Break only — non-zero-width children don't double-emit).
        if matches!(&span.element, ParsedElement::Break(_))
            && recursed_prosody
                .iter()
                .any(|&(s, e)| span.start >= s && span.end <= e)
        {
            continue;
        }
        match &span.element {
            ParsedElement::Speak(_) => {}
            ParsedElement::Prosody(attrs) => {
                if prosody_is_whole_utterance(span, &text, input) {
                    let rate_str = attrs.rate.as_ref().map(|r| r.to_string());
                    let parsed_rate = rate_str.as_deref().and_then(parse_rate_value);
                    if let Some(rate) = parsed_rate {
                        push_text_slice(&mut segments, &text, cursor, span.start);
                        let inner_segs = parse_inner_spans(&spans, &text, span.start, span.end);
                        segments.push(Segment::ProsodyRate {
                            rate,
                            content: inner_segs,
                        });
                        cursor = span.end;
                    } else {
                        warn_once(
                            WARN_PROSODY_NO_SUPPORTED_ATTR,
                            "SSML <prosody> without a parseable rate= attribute \
                             is not supported (pitch/volume scoped to a follow-up); stripping",
                        );
                    }
                } else {
                    warn_once(
                        WARN_PROSODY_MID_UTTERANCE,
                        "SSML <prosody> mid-utterance is not yet supported \
                         (whole-utterance only); stripping rate, pitch, and volume",
                    );
                }
            }
            _ => {
                if let Some(new_cursor) = emit_span(span, &text, &mut segments, cursor) {
                    cursor = new_cursor;
                }
            }
        }
    }
    push_text_slice(&mut segments, &text, cursor, text.len());
    Ok(segments)
}

/// True when `<prosody>` is the sole meaningful child of `<speak>`. Source-sibling
/// check needed because zero-width tags (`<break/>`) collapse to the same text offset
/// and can't be distinguished from inside-prosody via text spans alone. (#560)
fn prosody_is_whole_utterance(
    span: &ssml_parser::parser::Span,
    text: &[char],
    input: &str,
) -> bool {
    let prefix: String = text[..span.start].iter().collect();
    let suffix: String = text[span.end..].iter().collect();
    prefix.trim().is_empty() && suffix.trim().is_empty() && !has_structural_source_siblings(input)
}

/// Returns trimmed inner text, or `None` if empty/whitespace-only.
pub(super) fn extract_inner_text(text: &[char], start: usize, end: usize) -> Option<String> {
    let raw: String = text[start..end].iter().collect();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn tag_name(el: &ParsedElement) -> String {
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

    // Full parse() integration tests live in rust/tests/ssml_integration.rs (#267 F8).
    // This block covers only pub(super) items unreachable from there — currently tag_name.

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
}
