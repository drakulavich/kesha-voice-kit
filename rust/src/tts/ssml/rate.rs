//! `<prosody rate="...">` attribute parsing and the source-position helper
//! that complements the text-offset whole-utterance check in `parse()`.

/// Parse an SSML `prosody rate` attribute value into a raw multiplier.
/// Supports W3C named values (`x-slow`/`slow`/`medium`/`fast`/`x-fast`/`default`),
/// absolute `N%`, and relative `+N%` / `-N%`. Returns `None` on malformed
/// input, zero/negative results, or non-finite values (`NaN`, `±inf`).
///
/// Relative `+N%`/`-N%` arms are unreachable from `parse()` — `ssml-parser` 0.1.4
/// strips the sign before we see it; `parse()` pre-scans and rejects them to avoid
/// silent miscoercion. Arms remain for direct-call correctness and SSML 1.1 mapping.
///
/// Does not clamp: the dispatcher composes with `--rate` then clamps once, so
/// `--rate 0.6` × `<prosody rate="400%">` saturates at 2.0× rather than landing
/// at 1.2× from a pre-clamped SSML multiplier.
pub(super) fn parse_rate_value(s: &str) -> Option<f32> {
    let s = s.trim();
    let mult = match s {
        "x-slow" => 0.5_f32,
        "slow" => 0.75,
        // SSML 1.1: `default` means "use the voice's default rate" — i.e. 1.0×.
        "medium" | "default" => 1.0,
        "fast" => 1.25,
        "x-fast" => 1.5,
        _ => {
            let pct = s.strip_suffix('%')?;
            if let Some(rest) = pct.strip_prefix('+') {
                // Reject double signs like "++50%" symmetrically with the `-` arm below.
                if rest.starts_with('-') || rest.starts_with('+') {
                    return None;
                }
                let n: f32 = rest.parse().ok()?;
                1.0 + n / 100.0
            } else if let Some(rest) = pct.strip_prefix('-') {
                if rest.starts_with('-') || rest.starts_with('+') {
                    return None;
                }
                let n: f32 = rest.parse().ok()?;
                1.0 - n / 100.0
            } else {
                let n: f32 = pct.parse().ok()?;
                n / 100.0
            }
        }
    };
    // NaN/±inf from `f32::from_str` would propagate through `.clamp` to the ONNX speed tensor.
    if !mult.is_finite() {
        return None;
    }
    // Zero/negative means "stop" semantically; clamping it to 0.5× silently is surprising.
    if mult <= 0.0 {
        return None;
    }
    Some(mult)
}

/// Scan the raw SSML input for the first relative-percent rate attribute
/// (`rate="+N%"` or `rate="-N%"`). Returns the matched attribute value on
/// hit. Used by `parse()` to reject inputs where `ssml-parser` would
/// silently strip the sign (`+25%` → `25%` → 0.25× instead of 1.25×) or
/// hard-fail with a cryptic upstream message (`-25%` → "Negative percentage
/// not allowed for rate"). Input length is bounded by `MAX_TEXT_CHARS`, so
/// the O(n) scan is cheap.
pub(super) fn find_relative_rate(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let needle = b"rate=";
    let mut i = 0;
    while i + needle.len() < bytes.len() {
        if !bytes[i..i + needle.len()].eq_ignore_ascii_case(needle) {
            i += 1;
            continue;
        }
        let after = i + needle.len();
        let (quote, value_start) = match bytes.get(after) {
            Some(b'"') => (b'"', after + 1),
            Some(b'\'') => (b'\'', after + 1),
            _ => {
                i = after;
                continue;
            }
        };
        if let Some(close_rel) = bytes[value_start..].iter().position(|&b| b == quote) {
            let value_bytes = &bytes[value_start..value_start + close_rel];
            // Skip leading whitespace per SSML/XML normalization.
            let trimmed_start = value_bytes
                .iter()
                .position(|b| !b.is_ascii_whitespace())
                .unwrap_or(value_bytes.len());
            let trimmed = &value_bytes[trimmed_start..];
            if let Some(&first) = trimmed.first() {
                if (first == b'+' || first == b'-')
                    && trimmed.get(1).is_some_and(|c| c.is_ascii_digit())
                {
                    if let Ok(s) = std::str::from_utf8(value_bytes) {
                        return Some(s.to_string());
                    }
                }
            }
            i = value_start + close_rel + 1;
        } else {
            // Unclosed quote — let ssml-parser surface the real error.
            return None;
        }
    }
    None
}

/// Check whether the raw SSML source has any non-whitespace content between
/// `<speak ...>` and the first `<prosody ...>` opening tag, or between
/// `</prosody>` and `</speak>`. Used as the source-position complement to the
/// text-offset whole-utterance check — zero-width tags like `<break/>`
/// collapse to the same text offset as the prosody boundary and cannot be
/// distinguished by text-position alone.
///
/// Conservative: any `<` between `<speak ...>` and `<prosody>` counts as a
/// sibling, including the opening tag of another non-prosody element. Returns
/// false when the document is malformed (no `<prosody>`, no matching close
/// tags, or out-of-order tags) so the existing parser error path takes over.
pub(super) fn has_structural_source_siblings(input: &str) -> bool {
    let speak_open_end = match input.find("<speak") {
        Some(p) => match input[p..].find('>') {
            Some(e) => p + e + 1,
            None => return false,
        },
        None => return false,
    };
    // Use the LAST `</prosody>` so nested prosody doesn't break the outer whole-utterance check.
    let prosody_open = match input.find("<prosody") {
        Some(p) => p,
        None => return false,
    };
    let prosody_close_end = match input.rfind("</prosody>") {
        Some(p) => p + "</prosody>".len(),
        None => return false,
    };
    let speak_close = match input.rfind("</speak>") {
        Some(p) => p,
        None => return false,
    };
    // Malformed ordering — let ssml-parser surface the real error.
    if speak_open_end > prosody_open || prosody_close_end > speak_close {
        return false;
    }
    !input[speak_open_end..prosody_open].trim().is_empty()
        || !input[prosody_close_end..speak_close].trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rate_named_values() {
        assert_eq!(parse_rate_value("x-slow"), Some(0.5));
        assert_eq!(parse_rate_value("slow"), Some(0.75));
        assert_eq!(parse_rate_value("medium"), Some(1.0));
        assert_eq!(parse_rate_value("fast"), Some(1.25));
        assert_eq!(parse_rate_value("x-fast"), Some(1.5));
    }

    #[test]
    fn parse_rate_percent_absolute() {
        assert_eq!(parse_rate_value("100%"), Some(1.0));
        assert_eq!(parse_rate_value("50%"), Some(0.5));
        assert_eq!(parse_rate_value("150%"), Some(1.5));
        assert_eq!(parse_rate_value("200%"), Some(2.0));
    }

    #[test]
    fn parse_rate_percent_relative() {
        assert_eq!(parse_rate_value("+25%"), Some(1.25));
        assert_eq!(parse_rate_value("-25%"), Some(0.75));
        assert_eq!(parse_rate_value("+0%"), Some(1.0));
    }

    #[test]
    fn parse_rate_returns_raw_multiplier_clamping_happens_at_synth() {
        assert_eq!(parse_rate_value("10%"), Some(0.1));
        assert_eq!(parse_rate_value("400%"), Some(4.0));
        assert_eq!(parse_rate_value("+500%"), Some(6.0));
        let neg = parse_rate_value("-90%").unwrap();
        assert!((neg - 0.1).abs() < 1e-6, "got {neg}");
    }

    #[test]
    fn parse_rate_malformed_returns_none() {
        assert_eq!(parse_rate_value(""), None);
        assert_eq!(parse_rate_value("abc"), None);
        assert_eq!(parse_rate_value("100"), None);
        assert_eq!(parse_rate_value("--50%"), None);
        assert_eq!(parse_rate_value("++50%"), None);
        assert_eq!(parse_rate_value("xx-slow"), None);
    }

    #[test]
    fn parse_rate_rejects_zero_and_negative_results() {
        // `0%` parses cleanly but means "stop"; 0.0 would clamp UP to 0.5×.
        assert_eq!(parse_rate_value("0%"), None);
        assert_eq!(parse_rate_value("-100%"), None);
        assert_eq!(parse_rate_value("-150%"), None);
    }

    #[test]
    fn parse_rate_accepts_default_keyword() {
        // SSML 1.1 "default" means "the voice's default rate" — i.e. 1.0×.
        // Previously fell through to the malformed path → warn-strip.
        assert_eq!(parse_rate_value("default"), Some(1.0));
    }

    #[test]
    fn parse_rate_rejects_non_finite_values() {
        // `f32::from_str` accepts "NaN"/"inf"/"Infinity"; NaN propagates through `.clamp` to the ONNX tensor.
        assert_eq!(parse_rate_value("NaN%"), None);
        assert_eq!(parse_rate_value("nan%"), None);
        assert_eq!(parse_rate_value("inf%"), None);
        assert_eq!(parse_rate_value("Infinity%"), None);
        assert_eq!(parse_rate_value("+inf%"), None);
        assert_eq!(parse_rate_value("-inf%"), None);
        assert_eq!(parse_rate_value("+NaN%"), None);
    }
}
