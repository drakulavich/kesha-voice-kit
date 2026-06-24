//! Walker over `ssml-parser` spans that builds segment lists. Lives in its own
//! module so the top-level `parse()` and the recursive whole-utterance
//! `<prosody>` body share the same emit/skip logic without duplication.

use ssml_parser::elements::{EmphasisLevel, ParsedElement, PhonemeAlphabet};

use crate::tts::warn::warn_once;

use super::segment::{Segment, DEFAULT_BREAK};
use super::warnings::WARN_PROSODY_NESTED;
use super::{extract_inner_text, tag_name};

/// Sort key for span ordering: lower priority runs FIRST in the segment
/// loop. When two spans share `span.start` (e.g. an inner `<say-as>`
/// nested inside `<emphasis>`), the lower-priority arm runs first and
/// advances the cursor; the higher-priority arm is then skipped by the
/// loop-top `cursor` guard. This implements the spec's "inner structural
/// tag wins" rule for nested SSML.
///
/// Priority assignments (#233):
/// - 0: structural-leaf tags (Phoneme, SayAs) — run first, consume span
/// - 1: Break and other non-overlapping containers
/// - 2: Emphasis — run after inner leaves; otherwise wraps them
/// - 3: Speak root wrapper
pub(super) fn span_priority(el: &ParsedElement) -> u8 {
    match el {
        ParsedElement::Phoneme(_) | ParsedElement::SayAs(_) => 0,
        ParsedElement::Break(_) => 1,
        ParsedElement::Emphasis(_) | ParsedElement::Prosody(_) => 2,
        ParsedElement::Speak(_) => 3,
        _ => 1,
    }
}

pub(super) fn push_text_slice(out: &mut Vec<Segment>, text: &[char], start: usize, end: usize) {
    if start >= end {
        return;
    }
    let chunk: String = text[start..end].iter().collect();
    if !chunk.trim().is_empty() {
        out.push(Segment::Text(chunk));
    }
}

/// Emit a single IPA or warn-strip a non-IPA phoneme.
/// Returns `Some(span_end)` when the span was consumed (IPA path), or
/// `None` when the alphabet is unsupported and the cursor must not move.
fn emit_phoneme(
    attrs: &ssml_parser::elements::PhonemeAttributes,
    text: &[char],
    segments: &mut Vec<Segment>,
    cursor: usize,
    span_start: usize,
    span_end: usize,
) -> Option<usize> {
    let is_ipa = matches!(&attrs.alphabet, None | Some(PhonemeAlphabet::Ipa));
    if !is_ipa {
        // `is_ipa` above already filtered `None` and `Some(Ipa)`,
        // so the only remaining variant today is `Other(s)`. Future
        // `ssml-parser` enum growth falls into the wildcard with a
        // synthesized name — warn + strip, never panic on user input.
        let alpha = match &attrs.alphabet {
            Some(PhonemeAlphabet::Other(s)) => s.clone(),
            other => format!("{other:?}"),
        };
        warn_once(
            &format!("phoneme[alphabet={alpha}]"),
            &format!(
                "SSML <phoneme alphabet=\"{alpha}\"> not supported — only \"ipa\" is recognised; falling back to G2P on contained text"
            ),
        );
        return None;
    }
    push_text_slice(segments, text, cursor, span_start);
    if !attrs.ph.is_empty() {
        segments.push(Segment::Ipa(attrs.ph.clone()));
    }
    Some(span_end)
}

/// Emit segments for one span covering Break / Phoneme / SayAs / Emphasis /
/// unknown-tag arms. The Prosody arm (which recurses into `parse_inner_spans`)
/// and the Speak root-skip arm are intentionally excluded and handled inline by
/// the callers.
///
/// Returns `Some(new_cursor)` when the span was consumed and the caller should
/// advance the cursor to that value. Returns `None` for warn-strip cases where
/// the cursor must not move (non-IPA phoneme, unrecognised say-as, unknown tag).
pub(super) fn emit_span(
    span: &ssml_parser::parser::Span,
    text: &[char],
    segments: &mut Vec<Segment>,
    cursor: usize,
) -> Option<usize> {
    match &span.element {
        ParsedElement::Break(attrs) => {
            push_text_slice(segments, text, cursor, span.start);
            let dur = attrs
                .time
                .as_ref()
                .map(|t| t.duration())
                .unwrap_or(DEFAULT_BREAK);
            segments.push(Segment::Break(dur));
            Some(span.end)
        }
        ParsedElement::Phoneme(attrs) => {
            emit_phoneme(attrs, text, segments, cursor, span.start, span.end)
        }
        ParsedElement::SayAs(attrs) => {
            if attrs.interpret_as == "characters" {
                // Emit any pending text up to the tag, then a Spell segment for
                // the inner text. Cursor advances past the closing tag so we
                // don't double-emit the inner content as a Text fall-through.
                push_text_slice(segments, text, cursor, span.start);
                if let Some(inner) = extract_inner_text(text, span.start, span.end) {
                    segments.push(Segment::Spell(inner));
                }
                Some(span.end)
            } else {
                // Other interpret-as values (cardinal, ordinal, date, telephone, …)
                // are out of scope for #232. Keep the established warn+strip
                // behavior; the inner text falls through as a Text segment.
                warn_once(
                    &format!("say-as[interpret-as={}]", attrs.interpret_as),
                    &format!(
                        "SSML <say-as interpret-as=\"{}\"> is not supported — only \"characters\" is recognised; falling back to plain text",
                        attrs.interpret_as
                    ),
                );
                None
            }
        }
        ParsedElement::Emphasis(attrs) => {
            push_text_slice(segments, text, cursor, span.start);
            if let Some(content) = extract_inner_text(text, span.start, span.end) {
                // SSML 1.1: missing/empty level == "moderate" (default). Only
                // `level="none"` triggers suppression — all other variants
                // (Strong, Moderate, Reduced) collapse to "honor `+` markers".
                let suppress = matches!(attrs.level, Some(EmphasisLevel::None));
                segments.push(Segment::Emphasis { content, suppress });
            }
            // Cursor advances past the entire emphasis span. Any structural child
            // (e.g. <break/>, <say-as>, <phoneme>) whose `start` falls within
            // [span.start, span.end) will be skipped by the loop-top
            // `if span.start < cursor { continue; }` guard. For <say-as> /
            // <phoneme> this is the desired "inner tag wins" behavior (the inner
            // arm runs first via span_priority sort and consumes its own range);
            // for <break/> the silence is silently absorbed into the emphasis
            // content. Out of scope per the #233 spec; tracked separately if a
            // real user hits it.
            Some(span.end)
        }
        other => {
            let name = tag_name(other);
            warn_once(
                &format!("unknown-tag-{name}"),
                &format!("SSML tag <{name}> is not supported — stripping"),
            );
            // Preserve the text content; don't touch cursor.
            None
        }
    }
}

/// Parse the inner content of a whole-utterance `<prosody>` span into segments.
/// Iterates the sub-spans whose character range falls strictly within
/// `[prosody_start, prosody_end)`, applying the same rules as the top-level
/// walker (Break, Phoneme, SayAs, Emphasis). Unknown tags warn+strip via the
/// process-wide `warn_once` (#275 D2 — was a per-call `HashSet` before, which
/// re-fired warnings on every `--stdin-loop` request).
pub(super) fn parse_inner_spans(
    all_spans: &[&ssml_parser::parser::Span],
    text: &[char],
    prosody_start: usize,
    prosody_end: usize,
) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    let mut cursor = prosody_start;

    // Filter to spans that are strictly children of the prosody span
    // (start >= prosody_start, end <= prosody_end) and are not the prosody
    // span itself (we skip the Prosody element and the Speak wrapper).
    for span in all_spans {
        if span.start < prosody_start || span.end > prosody_end {
            continue;
        }
        // R3: skip the outer prosody span itself — `all_spans` includes it
        // because its `(start, end)` matches the prosody range. Without this
        // guard, the Prosody match arm below would fire `prosody-nested`
        // for every whole-utterance prosody.
        if span.start == prosody_start
            && span.end == prosody_end
            && matches!(&span.element, ParsedElement::Prosody(_))
        {
            continue;
        }
        if span.start < cursor {
            continue;
        }
        match &span.element {
            ParsedElement::Speak(_) => {
                // Skip the speak wrapper — we're already inside it.
            }
            ParsedElement::Prosody(_) => {
                // Nested <prosody> inside another <prosody>: not supported in v1.
                // Inner attributes are dropped; inner content flows at the outer
                // rate via the trailing push_text_slice plus any leaf spans below.
                warn_once(
                    WARN_PROSODY_NESTED,
                    "SSML <prosody> nested inside another <prosody> is not \
                     supported; inner rate/pitch/volume attributes ignored",
                );
            }
            _ => {
                if let Some(new_cursor) = emit_span(span, text, &mut segments, cursor) {
                    cursor = new_cursor;
                }
            }
        }
    }
    // Trailing text inside the prosody span.
    push_text_slice(&mut segments, text, cursor, prosody_end);
    segments
}

#[cfg(test)]
#[cfg(feature = "tts")]
mod tests {
    use crate::tts::ssml::{parse, Segment};

    // T1: <break> inside a whole-utterance <prosody rate="fast"> produces
    // [Text, Break(300ms), Text] inside the ProsodyRate content.
    #[test]
    fn break_inside_prosody_content_has_text_break_text() {
        let segs = parse(
            r#"<speak><prosody rate="fast">Hello <break time="300ms"/> world</prosody></speak>"#,
        )
        .unwrap();
        assert_eq!(segs.len(), 1, "expected single ProsodyRate, got: {segs:?}");
        let content = match &segs[0] {
            Segment::ProsodyRate { rate, content } => {
                assert!((*rate - 1.25).abs() < 1e-6, "rate: {rate}");
                content
            }
            other => panic!("expected ProsodyRate, got {other:?}"),
        };
        // Expect Text, Break(300ms), Text — in that order.
        assert_eq!(content.len(), 3, "inner segments: {content:?}");
        assert!(
            matches!(&content[0], Segment::Text(t) if t.contains("Hello")),
            "content[0]: {:?}",
            content[0]
        );
        assert!(
            matches!(&content[1], Segment::Break(d) if (d.as_millis() as i64 - 300).abs() <= 1),
            "content[1]: {:?}",
            content[1]
        );
        assert!(
            matches!(&content[2], Segment::Text(t) if t.contains("world")),
            "content[2]: {:?}",
            content[2]
        );
    }

    // T2: IPA <phoneme> inside a whole-utterance <prosody> — the phoneme span
    // has priority 0 and the prosody has priority 2 in the top-level sort, so
    // the phoneme arm runs first, advances cursor past the whole prosody range,
    // and the prosody span is skipped by the cursor guard. Actual output: a
    // flat [Ipa(...)] with no ProsodyRate wrapper.
    #[test]
    fn ipa_phoneme_inside_prosody_emits_ipa_segment() {
        let segs = parse(
            r#"<speak><prosody rate="fast"><phoneme alphabet="ipa" ph="həˈloʊ">hello</phoneme></prosody></speak>"#,
        )
        .unwrap();
        // Inner phoneme wins (priority 0 < prosody priority 2); no ProsodyRate wrapper.
        assert!(
            segs.iter()
                .any(|s| matches!(s, Segment::Ipa(p) if p == "həˈloʊ")),
            "no Ipa segment found in: {segs:?}"
        );
        assert!(
            !segs
                .iter()
                .any(|s| matches!(s, Segment::ProsodyRate { .. })),
            "unexpected ProsodyRate wrapper: {segs:?}"
        );
        // Inner "hello" text must NOT leak.
        assert!(
            !segs
                .iter()
                .any(|s| matches!(s, Segment::Text(t) if t.contains("hello"))),
            "inner text leaked: {segs:?}"
        );
    }

    // T3: non-IPA <phoneme alphabet="x-sampa"> inside prosody → warn-strip,
    // text flows as Text, no Ipa segment.
    #[test]
    fn non_ipa_phoneme_inside_prosody_warn_strips_and_text_flows() {
        let segs = parse(
            r#"<speak><prosody rate="fast"><phoneme alphabet="x-sampa" ph="h@_'low">hello</phoneme></prosody></speak>"#,
        )
        .unwrap();
        let content = match &segs[0] {
            Segment::ProsodyRate { content, .. } => content,
            other => panic!("expected ProsodyRate, got {other:?}"),
        };
        // No Ipa segment.
        assert!(
            !content.iter().any(|s| matches!(s, Segment::Ipa(_))),
            "unexpected Ipa in: {content:?}"
        );
        // Inner text still flows through as Text so G2P handles it.
        assert!(
            content
                .iter()
                .any(|s| matches!(s, Segment::Text(t) if t.contains("hello"))),
            "inner text missing from: {content:?}"
        );
    }

    // T4: <say-as interpret-as="characters"> inside a whole-utterance <prosody>
    // — SayAs has priority 0 and prosody priority 2; the say-as arm runs first,
    // advances cursor past the whole prosody range, and prosody is skipped.
    // Actual output: flat [Spell("ВОЗ")] with no ProsodyRate wrapper.
    #[test]
    fn say_as_characters_inside_prosody_emits_spell() {
        let segs = parse(
            r#"<speak><prosody rate="slow"><say-as interpret-as="characters">ВОЗ</say-as></prosody></speak>"#,
        )
        .unwrap();
        // Inner say-as wins (priority 0 < prosody priority 2); no ProsodyRate wrapper.
        assert!(
            segs.iter()
                .any(|s| matches!(s, Segment::Spell(t) if t == "ВОЗ")),
            "no Spell segment found in: {segs:?}"
        );
        assert!(
            !segs
                .iter()
                .any(|s| matches!(s, Segment::ProsodyRate { .. })),
            "unexpected ProsodyRate wrapper: {segs:?}"
        );
    }

    // T5: <emphasis level="none"> inside prosody → Emphasis { suppress: true }
    #[test]
    fn emphasis_none_inside_prosody_sets_suppress_true() {
        let segs = parse(
            r#"<speak><prosody rate="fast"><emphasis level="none">д+ома</emphasis></prosody></speak>"#,
        )
        .unwrap();
        let content = match &segs[0] {
            Segment::ProsodyRate { content, .. } => content,
            other => panic!("expected ProsodyRate, got {other:?}"),
        };
        assert!(
            content
                .iter()
                .any(|s| matches!(s, Segment::Emphasis { suppress: true, .. })),
            "no Emphasis{{suppress:true}} in: {content:?}"
        );
    }

    // T6: unknown tag (<audio>) inside prosody → warn-strip, text preserved, no panic.
    #[test]
    fn unknown_tag_inside_prosody_warn_strips_and_text_preserved() {
        let segs = parse(
            r#"<speak><prosody rate="fast">before <audio src="x.mp3"/> after</prosody></speak>"#,
        )
        .unwrap();
        let content = match &segs[0] {
            Segment::ProsodyRate { content, .. } => content,
            other => panic!("expected ProsodyRate, got {other:?}"),
        };
        // Text should flow through; the <audio> tag is stripped but
        // surrounding text is preserved.
        let all_text: String = content
            .iter()
            .filter_map(|s| match s {
                Segment::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            all_text.contains("before") && all_text.contains("after"),
            "text lost: {all_text:?} from {content:?}"
        );
    }

    // KNOWN QUIRK (BUG, tracked in issue #560): a <break> at the start of a
    // <prosody> is emitted TWICE — once flat, once again inside ProsodyRate.
    // This is PRE-EXISTING behavior; this test pins the current output so the
    // eventual fix is a deliberate, visible change — it is NOT asserting that
    // double-emission is the desired result.
    //
    // Mechanism: the two <break> spans share the prosody span's start position.
    // Break (priority 1) sorts before Prosody (priority 2) and emits flat Break
    // segments; cursor does NOT advance past the prosody range (each break only
    // advances to its own end), so the Prosody arm still fires afterward and
    // emits a ProsodyRate wrapping the same breaks again. Actual output:
    // [Break(100ms), Break(200ms), ProsodyRate { content: [Break(100ms), Break(200ms)] }].
    // Also exercises push_text_slice dropping whitespace-only chunks (no Text).
    #[test]
    fn known_quirk_prosody_leading_break_double_emitted() {
        let segs = parse(
            r#"<speak><prosody rate="fast"><break time="100ms"/> <break time="200ms"/></prosody></speak>"#,
        )
        .unwrap();
        // Both flat breaks appear at the top level.
        let flat_break_count = segs
            .iter()
            .filter(|s| matches!(s, Segment::Break(_)))
            .count();
        assert_eq!(flat_break_count, 2, "expected 2 flat breaks, got: {segs:?}");
        // The ProsodyRate wrapper also fires and contains the same breaks.
        let prosody = segs.iter().find_map(|s| match s {
            Segment::ProsodyRate { rate, content } => Some((rate, content)),
            _ => None,
        });
        let (rate, content) = prosody.expect("expected ProsodyRate segment in output");
        assert!((*rate - 1.25).abs() < 1e-6, "rate: {rate}");
        let inner_break_count = content
            .iter()
            .filter(|s| matches!(s, Segment::Break(_)))
            .count();
        assert_eq!(
            inner_break_count, 2,
            "expected 2 inner breaks, got: {content:?}"
        );
        // No Text segments anywhere (whitespace-only dropped).
        let text_count = segs
            .iter()
            .filter(|s| matches!(s, Segment::Text(_)))
            .count();
        assert_eq!(text_count, 0, "expected no text, got: {segs:?}");
    }
}
