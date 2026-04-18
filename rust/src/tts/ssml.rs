//! SSML → linear segment list for the TTS pipeline.
//!
//! v1 scope (issue #122):
//! - `<speak>` root wrapper
//! - `<break time="...">` → silence segment of the given duration
//! - plain text inside/between elements → text segment for synthesis
//! - unknown tags: one stderr warning per tag name, contained text preserved

use std::collections::HashSet;
use std::time::Duration;

use ssml_parser::elements::ParsedElement;
use ssml_parser::parse_ssml;

/// A linearized slice of an SSML document.
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    /// Plain text to feed into the G2P → engine pipeline.
    Text(String),
    /// Silence of the given duration.
    Break(Duration),
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
    // Reject DOCTYPE declarations — defense in depth against billion-laughs / XXE,
    // even though ssml-parser doesn't currently expand external entities.
    let leading = trimmed
        .chars()
        .take(256)
        .collect::<String>()
        .to_ascii_uppercase();
    if leading.contains("<!DOCTYPE") {
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
    // ParsedElement variant names mirror SSML element names; Debug gives `Variant(attrs)`.
    // Strip to just the lowercased head.
    let dbg = format!("{:?}", el);
    let head = dbg.split('(').next().unwrap_or("unknown");
    head.to_ascii_lowercase()
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
}
