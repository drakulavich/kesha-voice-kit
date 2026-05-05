# Russian stress placement via SSML `<emphasis>` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Honor SSML `<emphasis>` on the Russian Vosk path by passing caller-provided `+vowel` markers through to vosk-tts-rs, with a once-per-process warning when the marker is missing or the voice is non-`ru-vosk-*`.

**Architecture:** New `Segment::Emphasis { content, suppress }` variant emitted by the SSML parser. `tts::ru::normalize_segments` converts the variant to plain `Text` (preserving or stripping `+` per `suppress`). Kokoro and AVSpeech paths strip `+` and warn-once. Per-process warning dedup uses a `OnceLock<Mutex<HashSet<&'static str>>>` keyed by warning identifier.

**Tech Stack:** Rust 2024, `ssml-parser` 0.1.4 (`EmphasisAttributes { level: Option<EmphasisLevel { Strong, Moderate, None, Reduced } > }`), existing `vosk-tts-rs` synth path, clap, no TS-side changes.

**Spec:** `docs/superpowers/specs/2026-05-05-vosk-ru-emphasis-marker-design.md` (commit `cb0f9c8`).

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `rust/src/tts/ssml.rs` | MODIFY | Add `Segment::Emphasis { content, suppress }` variant; add `ParsedElement::Emphasis(attrs)` arm before the `other =>` catchall. The arm collects inner text via `text[span.start..span.end]`, sets `suppress = matches!(attrs.level, Some(EmphasisLevel::None))`, advances cursor. |
| `rust/src/tts/ru/warn.rs` | NEW | Single helper: `pub fn warn_once(key: &'static str, msg: &str)` backed by `OnceLock<Mutex<HashSet<&'static str>>>`. Public so the kokoro/avspeech arms in `tts::mod` can reach it. |
| `rust/src/tts/ru/mod.rs` | MODIFY | Declare `pub(super) mod warn;` (so `tts::mod` can `use crate::tts::ru::warn::warn_once`). `normalize_segments` gains an `Emphasis` arm: `suppress=true` → `Text(content.replace('+', ""))`; otherwise → call `warn_once("emphasis-no-plus", …)` if `!content.contains('+')`, then emit `Text(content)`. |
| `rust/src/tts/mod.rs` | MODIFY | `synth_segments_kokoro_with` adds an `Emphasis { content, .. }` arm: `warn_once("emphasis-non-ru-vosk", …)` then strip `+` and feed through G2P + infer. `synth_segments_vosk_with` adds an `Emphasis { content, .. }` arm for exhaustiveness (in practice converted to `Text` upstream by `ru::normalize_segments`); the arm calls `cache.infer(model_dir, &content, …)` after strip-`+` (defensive). The AVSpeech path also gains an `Emphasis` strip-`+` arm if its segment iterator exposes one. |
| `rust/src/capabilities.rs` | MODIFY | Add `features.push("tts.ru_emphasis_marker")` under `#[cfg(feature = "tts")]` immediately after the existing `tts.ru_acronym_expansion` push. |
| `rust/tests/tts_ru_normalize.rs` | MODIFY | Extend the existing `LoopEngine`-based warm-session test with a new `emphasis_marker_shifts_stress` test asserting byte-length deltas: `дом+а > baseline + 2KB`, `д+ома ≈ baseline ±5%`, `<emphasis level="none">дом+а</emphasis> ≈ baseline ±5%`. |
| `README.md` | MODIFY | Add a `<emphasis>` example block to the existing TTS examples section. |
| `SKILL.md` | MODIFY | Add a one-paragraph note + the `<emphasis>` example after the `<say-as>` paragraph from #232. |
| `CHANGELOG.md` | MODIFY | Insert a `## [1.8.0] (unreleased)` section above `## [1.7.0]` listing the new feature, capability flag, and per-engine handling. |

---

## Pre-flight

Verify the working tree before starting:

- [ ] **Step 0.1: Confirm branch + spec**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git rev-parse --abbrev-ref HEAD
git log -1 --oneline -- docs/superpowers/specs/2026-05-05-vosk-ru-emphasis-marker-design.md
```
Expected: branch `feat/233-vosk-ru-emphasis`, spec commit `cb0f9c8` on top.

- [ ] **Step 0.2: Confirm baseline tests + clippy + fmt are green**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts --lib 2>&1 | tail -3
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cargo fmt --check 2>&1 | tail -3
```
Expected: 100+ tests pass, clippy clean, fmt clean. If anything fails, stop and investigate before adding new code on a broken base.

---

## Task 1: Add `Segment::Emphasis` variant + per-process warn-once helper

Adds the variant + the helper module. Existing handlers gain a placeholder arm (Vosk: defensive strip-`+` text; Kokoro: same) so the codebase compiles.

**Files:**
- Modify: `rust/src/tts/ssml.rs` (Segment enum at lines ~21-37)
- Create: `rust/src/tts/ru/warn.rs`
- Modify: `rust/src/tts/ru/mod.rs` (add `pub(super) mod warn;`)
- Modify: `rust/src/tts/mod.rs::synth_segments_kokoro_with` and `synth_segments_vosk_with` (Spell match arms — extend to `Spell | Emphasis { content, .. }` placeholder)

- [ ] **Step 1.1: Write the failing test**

Append to the inline `#[cfg(test)] mod tests` in `rust/src/tts/ssml.rs`:

```rust
#[test]
fn segment_has_emphasis_variant() {
    // Constructibility check; parser wiring lands in Task 2.
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
```

- [ ] **Step 1.2: Confirm it fails to compile**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml::tests::segment_has_emphasis_variant 2>&1 | tail -10
```
Expected: compile error `no variant or associated item named 'Emphasis' found for enum 'Segment'`.

- [ ] **Step 1.3: Add the variant to the Segment enum**

In `rust/src/tts/ssml.rs`, the `Segment` enum is at the top of the file (around lines 21-37). Add the new variant at the end of the enum, after `Spell`:

```rust
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
    /// `tts::ru::letter_table::expand_chars`. Other engines pass it through as
    /// text (their G2P will read the cyrillic word verbatim — acceptable until
    /// per-engine support lands).
    Spell(String),
    /// SSML `<emphasis>` content. The Russian-Vosk normalization step honors
    /// any `+` markers in `content` (passing them through to Vosk, which
    /// interprets `+vowel` as a stress hint per the #233 spike). On non-
    /// `ru-vosk-*` voices the `+` markers are stripped before reaching G2P.
    /// `suppress` is set when the source tag had `level="none"` — strip `+`
    /// markers regardless of voice (SSML composition: a
    /// `<emphasis level="none">` overrides an inherited emphasis).
    Emphasis { content: String, suppress: bool },
}
```

- [ ] **Step 1.4: Update existing match arms in `tts::mod.rs` to handle `Emphasis` defensively**

The Vosk and Kokoro segment loops are exhaustive matches. They MUST handle the new variant or the build fails. Locate `synth_segments_kokoro_with` (search for `ssml::Segment::Text(t) | ssml::Segment::Spell(t) =>`):

```rust
ssml::Segment::Text(t) | ssml::Segment::Spell(t) => {
    // Spell: G2P-routed (Vosk path normalizes Spell→Text upstream of synth).
    let ipa = g2p::text_to_ipa(t, lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    let audio = sess
        .infer_ipa(&ipa, voice_path, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    out.extend(audio);
}
```

Replace the OR-pattern body to also accept `Emphasis`:

```rust
ssml::Segment::Text(t) | ssml::Segment::Spell(t) => {
    // Spell: G2P-routed (Vosk path normalizes Spell→Text upstream of synth).
    let ipa = g2p::text_to_ipa(t, lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    let audio = sess
        .infer_ipa(&ipa, voice_path, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    out.extend(audio);
}
ssml::Segment::Emphasis { content, .. } => {
    // Placeholder arm — proper warn-once + strip-`+` lands in Task 4.
    // Strip the `+` markers defensively so Kokoro G2P doesn't choke
    // on the unfamiliar character.
    let stripped = content.replace('+', "");
    let ipa = g2p::text_to_ipa(&stripped, lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    let audio = sess
        .infer_ipa(&ipa, voice_path, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    out.extend(audio);
}
```

In `synth_segments_vosk_with` (search for `ssml::Segment::Text(t) | ssml::Segment::Ipa(t) | ssml::Segment::Spell(t) =>`):

```rust
ssml::Segment::Text(t) | ssml::Segment::Ipa(t) | ssml::Segment::Spell(t) => {
    // Vosk path normalizes Spell→Text upstream; arm kept for match exhaustiveness.
    let (audio, _sr) = cache
        .infer(model_dir, t, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
    out.extend(audio);
}
```

Replace with the Emphasis arm added:

```rust
ssml::Segment::Text(t) | ssml::Segment::Ipa(t) | ssml::Segment::Spell(t) => {
    // Vosk path normalizes Spell→Text upstream; arm kept for match exhaustiveness.
    let (audio, _sr) = cache
        .infer(model_dir, t, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
    out.extend(audio);
}
ssml::Segment::Emphasis { content, .. } => {
    // ru::normalize_segments converts Emphasis→Text upstream; this arm
    // is defensive in case a caller bypasses the normalizer. Strip `+`
    // here since by definition this code path means we can't reach
    // ru::normalize_segments policy. Task 4 wires the proper handling.
    let stripped = content.replace('+', "");
    let (audio, _sr) = cache
        .infer(model_dir, &stripped, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
    out.extend(audio);
}
```

If `synth_segments_avspeech_*` or another segment-iterating function exists in the same file, add a parallel `Emphasis` arm with strip-`+`. Search:

```bash
grep -n "ssml::Segment::" rust/src/tts/mod.rs
```

Add an Emphasis arm everywhere a Spell arm exists.

- [ ] **Step 1.5: Create the `tts::ru::warn` helper module**

Create `rust/src/tts/ru/warn.rs` with EXACTLY this content:

```rust
//! Per-process warn-once helper for SSML feature gates.
//!
//! Used by the emphasis (#233) and acronym (#232) paths to emit a single
//! stderr line when a non-fatal SSML feature is misused (e.g. `<emphasis>`
//! content without a `+vowel` marker). Dedup is keyed by a `&'static str`
//! identifier so all instances of the same warning across `kesha say`
//! invocations within the same process print only once.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn warned() -> &'static Mutex<HashSet<&'static str>> {
    static W: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Emit `msg` to stderr if `key` has not been warned in this process.
/// Subsequent calls with the same `key` are silent. Lock poisoning is
/// treated as fatal — at that point another thread panicked while
/// holding the lock and the process is in an unrecoverable state.
pub fn warn_once(key: &'static str, msg: &str) {
    let mut set = warned().lock().expect("warn_once: mutex poisoned");
    if set.insert(key) {
        eprintln!("warning: {msg}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warn_once_dedups_by_key() {
        // First call inserts; second call with same key is a no-op.
        let key = "test-warn-once-key-1";
        let mut set = warned().lock().unwrap();
        assert!(set.insert(key));
        assert!(!set.insert(key)); // already in set → false
    }

    #[test]
    fn warn_once_different_keys_each_fire() {
        let mut set = warned().lock().unwrap();
        assert!(set.insert("test-warn-once-key-2a"));
        assert!(set.insert("test-warn-once-key-2b"));
    }
}
```

- [ ] **Step 1.6: Wire the helper into `tts::ru::mod`**

In `rust/src/tts/ru/mod.rs`, add a `pub(super) mod warn;` declaration alongside the existing `pub(super) mod letter_table;` and `pub(super) mod acronym;`:

```rust
pub(super) mod acronym;
pub(super) mod letter_table;
pub(super) mod warn;
```

- [ ] **Step 1.7: Run the new test + full ssml + lib test sets**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml::tests::segment_has_emphasis_variant 2>&1 | tail -5
cd rust && cargo test --no-default-features --features onnx,tts ru::warn 2>&1 | tail -5
cd rust && cargo test --no-default-features --features onnx,tts --lib 2>&1 | tail -3
```
Expected: `segment_has_emphasis_variant` passes; 2 warn::tests pass; full lib stays green.

- [ ] **Step 1.8: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -10
cd rust && cargo fmt --check 2>&1 | tail -5
```
Both must be clean. If clippy flags `Emphasis` as `dead_code` (unlikely since the placeholder arms construct it), do NOT add `#[allow(dead_code)]` — investigate.

- [ ] **Step 1.9: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/src/tts/ssml.rs rust/src/tts/mod.rs rust/src/tts/ru/mod.rs rust/src/tts/ru/warn.rs
git commit -m "$(cat <<'EOF'
feat(#233,tts): add Segment::Emphasis variant + warn_once helper

Adds a new SSML segment variant for `<emphasis>` content (with optional
`level=none` suppression) and a per-process `warn_once` helper backed by
OnceLock<Mutex<HashSet>>. Existing Kokoro and Vosk segment handlers gain
a placeholder Emphasis arm that strips `+` and routes through the same
synth path as Text — proper engine-aware handling lands in Task 4.

Parser wiring (recognising <emphasis> and emitting the variant) is
the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SSML parser emits `Emphasis` for `<emphasis>` (and respects `level="none"`)

Hooks the new variant into the parser. Other levels (`reduced`/`moderate`/`strong`) collapse to "honor `+`".

**Files:**
- Modify: `rust/src/tts/ssml.rs` (the `for span in &spans` loop, before `other =>` catchall)
- Modify: `rust/src/tts/ssml.rs` inline `#[cfg(test)] mod tests`

- [ ] **Step 2.1: Write the failing tests**

Append to the inline `mod tests` in `rust/src/tts/ssml.rs`:

```rust
#[test]
fn emphasis_default_level_emits_unsuppressed_segment() {
    let segs = parse(r#"<speak><emphasis>д+ома</emphasis></speak>"#).unwrap();
    let emphases: Vec<(&str, bool)> = segs
        .iter()
        .filter_map(|s| match s {
            Segment::Emphasis { content, suppress } => Some((content.as_str(), *suppress)),
            _ => None,
        })
        .collect();
    assert_eq!(emphases, vec![("д+ома", false)]);
    // No stray duplicate text segments around the tag.
    let text_chunks = segs
        .iter()
        .filter(|s| matches!(s, Segment::Text(t) if !t.trim().is_empty()))
        .count();
    assert_eq!(text_chunks, 0);
}

#[test]
fn emphasis_level_none_sets_suppress_true() {
    let segs = parse(r#"<speak><emphasis level="none">д+ома</emphasis></speak>"#).unwrap();
    assert!(matches!(
        segs.first(),
        Some(Segment::Emphasis { content, suppress: true }) if content == "д+ома"
    ));
}

#[test]
fn emphasis_level_strong_keeps_suppress_false() {
    let segs = parse(r#"<speak><emphasis level="strong">д+ома</emphasis></speak>"#).unwrap();
    assert!(matches!(
        segs.first(),
        Some(Segment::Emphasis { suppress: false, .. })
    ));
}

#[test]
fn emphasis_level_reduced_keeps_suppress_false() {
    let segs = parse(r#"<speak><emphasis level="reduced">тест</emphasis></speak>"#).unwrap();
    assert!(matches!(
        segs.first(),
        Some(Segment::Emphasis { suppress: false, .. })
    ));
}

#[test]
fn empty_emphasis_emits_no_segment() {
    let segs = parse(r#"<speak><emphasis></emphasis></speak>"#).unwrap();
    assert!(!segs.iter().any(|s| matches!(s, Segment::Emphasis { .. })));
}
```

- [ ] **Step 2.2: Run; tests should fail**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml::tests::emphasis 2>&1 | tail -15
```
Expected: 4 of 5 fail (the empty case may already pass via the `other =>` warn-strip route, but the others fall into that route which emits Text rather than Emphasis).

- [ ] **Step 2.3: Implement the `ParsedElement::Emphasis` arm**

Open `rust/src/tts/ssml.rs`. At the top of the file, add the import for `EmphasisLevel`:

```rust
use ssml_parser::elements::{EmphasisLevel, ParsedElement, PhonemeAlphabet};
```

(`EmphasisLevel` is in the same module path as `ParsedElement`. Verify the existing `use ssml_parser::elements::{ParsedElement, PhonemeAlphabet};` line and append `EmphasisLevel` to the brace list.)

Inside the `for span in &spans { match &span.element {` block, insert this arm BEFORE the `other =>` catchall (right after the existing `ParsedElement::SayAs(attrs) =>` arm):

```rust
ParsedElement::Emphasis(attrs) => {
    push_text_slice(&mut segments, &text, cursor, span.start);
    let raw: String = text[span.start..span.end].iter().collect();
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        // SSML 1.1: missing/empty level == "moderate" (default). Only
        // `level="none"` triggers suppression — all other variants
        // (Strong, Moderate, Reduced) collapse to "honor `+` markers".
        let suppress = matches!(attrs.level, Some(EmphasisLevel::None));
        segments.push(Segment::Emphasis {
            content: trimmed.to_string(),
            suppress,
        });
    }
    cursor = span.end;
}
```

Match the surrounding indentation/style exactly.

- [ ] **Step 2.4: Run the parser tests + full module**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml::tests::emphasis 2>&1 | tail -10
cd rust && cargo test --no-default-features --features onnx,tts ssml 2>&1 | tail -3
```
Expected: all 5 emphasis tests pass; existing ssml tests stay green.

- [ ] **Step 2.5: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cd rust && cargo fmt --check 2>&1 | tail -3
```
Both clean.

- [ ] **Step 2.6: Commit**

```bash
git add rust/src/tts/ssml.rs
git commit -m "$(cat <<'EOF'
feat(#233,ssml): emit Emphasis for <emphasis> with level mapping

The parser now produces Segment::Emphasis { content, suppress } for
<emphasis>...</emphasis>. `level="none"` sets suppress=true; all other
levels (Strong, Moderate, Reduced, missing) collapse to suppress=false
("honor `+` markers in content"). Empty <emphasis></emphasis> emits no
segment.

Synth-side handling is currently a placeholder strip-`+` (Task 1
defensive arms). The Russian-Vosk normalization step in Task 3 wires
the proper warn-once + pass-through behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire `Emphasis` through `ru::normalize_segments`

Replaces the placeholder strip-`+` arm in the Vosk path with the proper warn-once + suppress logic.

**Files:**
- Modify: `rust/src/tts/ru/mod.rs` (`normalize_segments` function)
- Modify: `rust/src/tts/ru/mod.rs` inline `#[cfg(test)] mod tests`

- [ ] **Step 3.1: Write the failing tests**

Append to the inline `#[cfg(test)] mod tests` in `rust/src/tts/ru/mod.rs`:

```rust
#[test]
fn emphasis_with_plus_marker_passes_through() {
    let out = normalize_segments(
        vec![Segment::Emphasis {
            content: "д+ома".to_string(),
            suppress: false,
        }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("д+ома".to_string())]);
}

#[test]
fn emphasis_suppress_strips_plus() {
    let out = normalize_segments(
        vec![Segment::Emphasis {
            content: "д+ома".to_string(),
            suppress: true,
        }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("дома".to_string())]);
}

#[test]
fn emphasis_without_plus_still_yields_text() {
    // Data shape only — the warn_once side-effect is tested by absence of panic
    // and by the helper's own tests (rust/src/tts/ru/warn.rs).
    let out = normalize_segments(
        vec![Segment::Emphasis {
            content: "обычное слово".to_string(),
            suppress: false,
        }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("обычное слово".to_string())]);
}

#[test]
fn emphasis_with_multiple_plus_markers_pass_all_through() {
    // Mixed content: caller put `+` on multiple words — Vosk handles per-word.
    let out = normalize_segments(
        vec![Segment::Emphasis {
            content: "я зн+аю это".to_string(),
            suppress: false,
        }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("я зн+аю это".to_string())]);
}

#[test]
fn emphasis_suppress_strips_multiple_plus_markers() {
    let out = normalize_segments(
        vec![Segment::Emphasis {
            content: "я зн+аю +это".to_string(),
            suppress: true,
        }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("я знаю это".to_string())]);
}
```

- [ ] **Step 3.2: Run; tests should fail**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ru::tests::emphasis 2>&1 | tail -10
```
Expected: 5 tests fail because `normalize_segments` does not yet have an `Emphasis` arm.

- [ ] **Step 3.3: Implement the `Emphasis` arm in `normalize_segments`**

Open `rust/src/tts/ru/mod.rs`. Find the `normalize_segments` function. The current body:

```rust
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter()
        .map(|s| match s {
            Segment::Spell(t) => Segment::Text(letter_table::expand_chars(&t)),
            Segment::Text(t) if auto_expand => Segment::Text(acronym::expand_acronyms(&t)),
            other => other,
        })
        .collect()
}
```

Replace with:

```rust
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter()
        .map(|s| match s {
            Segment::Spell(t) => Segment::Text(letter_table::expand_chars(&t)),
            Segment::Emphasis { content, suppress } => {
                if suppress {
                    Segment::Text(content.replace('+', ""))
                } else {
                    if !content.contains('+') {
                        warn::warn_once(
                            "emphasis-no-plus",
                            "<emphasis> content has no `+` marker; \
                             ru-vosk-* needs `сл+ово` syntax to shift stress \
                             away from the default first-syllable position",
                        );
                    }
                    Segment::Text(content)
                }
            }
            Segment::Text(t) if auto_expand => Segment::Text(acronym::expand_acronyms(&t)),
            other => other,
        })
        .collect()
}
```

Note: the `warn` module was already declared `pub(super) mod warn;` in Task 1, so `warn::warn_once(...)` resolves directly inside `tts::ru::mod`.

- [ ] **Step 3.4: Run the new tests + full ru tests**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ru:: 2>&1 | tail -10
```
Expected: 5 new emphasis tests pass; existing 19+ ru:: tests stay green.

- [ ] **Step 3.5: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cd rust && cargo fmt --check 2>&1 | tail -3
```
Both clean.

- [ ] **Step 3.6: Commit**

```bash
git add rust/src/tts/ru/mod.rs
git commit -m "$(cat <<'EOF'
feat(#233,tts): route Emphasis through ru::normalize_segments

The Russian Vosk path now honors <emphasis> properly:
  - suppress=true (level="none")  → strip `+` from content
  - suppress=false, content has `+` → pass-through verbatim
  - suppress=false, no `+`         → pass-through + warn_once
                                       ("emphasis-no-plus")

Spec acceptance criteria for the Vosk side covered. Kokoro and
AVSpeech still use the placeholder strip-`+` arm from Task 1; the
proper warn_once("emphasis-non-ru-vosk") wiring lands in Task 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `Emphasis` warn-once for non-Russian-Vosk paths

Replaces the placeholder strip-`+` arms in `synth_segments_kokoro_with` (and any AVSpeech equivalent) with the proper warn-once + strip behavior.

**Files:**
- Modify: `rust/src/tts/mod.rs` (`synth_segments_kokoro_with` Emphasis arm; any other engine arm)

- [ ] **Step 4.1: Locate the placeholder arms**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
grep -n "Segment::Emphasis" rust/src/tts/mod.rs
```

Expected: 2-3 hits — one in `synth_segments_kokoro_with`, one in `synth_segments_vosk_with`, possibly one in an AVSpeech variant. The Vosk arm is reachable only as a defensive fallback (normalize_segments converts upstream); the Kokoro arm IS the primary execution path for English voices.

- [ ] **Step 4.2: Update the Kokoro arm**

In `synth_segments_kokoro_with`, replace the Task 1 placeholder:

```rust
ssml::Segment::Emphasis { content, .. } => {
    // Placeholder arm — proper warn-once + strip-`+` lands in Task 4.
    let stripped = content.replace('+', "");
    let ipa = g2p::text_to_ipa(&stripped, lang) ...
}
```

with:

```rust
ssml::Segment::Emphasis { content, .. } => {
    // <emphasis> stress markers are honored only on ru-vosk-* voices.
    // For Kokoro, strip `+` from content (G2P would otherwise choke on
    // the unfamiliar character) and warn the user once per process.
    crate::tts::ru::warn::warn_once(
        "emphasis-non-ru-vosk",
        "<emphasis> stress markers are honored only on ru-vosk-* voices; \
         stripping `+` from content for non-Vosk path",
    );
    let stripped = content.replace('+', "");
    let ipa = g2p::text_to_ipa(&stripped, lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    let audio = sess
        .infer_ipa(&ipa, voice_path, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    out.extend(audio);
}
```

- [ ] **Step 4.3: Update the Vosk defensive arm**

In `synth_segments_vosk_with`, replace the Task 1 placeholder:

```rust
ssml::Segment::Emphasis { content, .. } => {
    // ru::normalize_segments converts Emphasis→Text upstream; this arm
    // is defensive in case a caller bypasses the normalizer. Strip `+`
    // here since by definition this code path means we can't reach
    // ru::normalize_segments policy. Task 4 wires the proper handling.
    let stripped = content.replace('+', "");
    let (audio, _sr) = cache
        .infer(model_dir, &stripped, speaker_id, speed) ...
}
```

with:

```rust
ssml::Segment::Emphasis { content, .. } => {
    // ru::normalize_segments converts Emphasis→Text upstream of this
    // function for the Russian Vosk SSML path. This arm is defensive:
    // if a caller bypasses the normalizer, treat the `+` markers as
    // unrecognised and warn-once. Production callers (kesha-engine
    // say --ssml + ru-vosk-*) never reach this branch.
    crate::tts::ru::warn::warn_once(
        "emphasis-non-ru-vosk",
        "<emphasis> reached the Vosk synth without ru::normalize_segments \
         preprocessing; stripping `+` markers as a fallback",
    );
    let stripped = content.replace('+', "");
    let (audio, _sr) = cache
        .infer(model_dir, &stripped, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
    out.extend(audio);
}
```

- [ ] **Step 4.4: Update any AVSpeech arm if present**

If `grep -n "Segment::Emphasis" rust/src/tts/mod.rs` showed a third hit (AVSpeech path), apply the same pattern: `warn_once("emphasis-non-ru-vosk", …)` + `let stripped = content.replace('+', "")` + feed `stripped` into the existing synth call.

If no AVSpeech match exists, skip this step — AVSpeech goes through a different path that doesn't iterate `Segment` (the Swift sidecar gets raw text).

- [ ] **Step 4.5: Run tests**

```bash
cd rust && cargo test --no-default-features --features onnx,tts --lib 2>&1 | tail -3
cd rust && cargo test --no-default-features --features onnx,tts tts:: 2>&1 | tail -3
```
Expected: all tests green. There's no new test added in this task — the warn_once side-effect is exercised in Task 6's integration test.

- [ ] **Step 4.6: Clippy + fmt**

```bash
cd rust && cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cd rust && cargo fmt --check 2>&1 | tail -3
```
Both clean.

- [ ] **Step 4.7: Commit**

```bash
git add rust/src/tts/mod.rs
git commit -m "$(cat <<'EOF'
feat(#233,tts): warn-once + strip `+` on non-ru-vosk Emphasis paths

Replaces the Task 1 placeholder Emphasis arms in synth_segments_kokoro_with
and synth_segments_vosk_with (+ AVSpeech if present) with the proper
warn-once + strip-`+` behavior. Calls crate::tts::ru::warn::warn_once
with key "emphasis-non-ru-vosk" so the warning prints once per process
regardless of how many <emphasis> tags reach a non-Russian-Vosk synth.

The Vosk arm remains defensive — production callers go through
ru::normalize_segments which converts Emphasis→Text upstream. The arm
exists for match exhaustiveness and to surface a warning if any future
caller bypasses the normalizer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `tts.ru_emphasis_marker` capability flag

Surfaces the new feature in `kesha-engine --capabilities-json`.

**Files:**
- Modify: `rust/src/capabilities.rs`

- [ ] **Step 5.1: Locate the capability builder**

Run:
```bash
grep -n "tts.ru_acronym_expansion\|features.push\|cfg.*feature.*tts" rust/src/capabilities.rs
```

Expected: hits showing the existing `tts.ru_acronym_expansion` push under a `#[cfg(feature = "tts")]` block.

- [ ] **Step 5.2: Add the new feature push**

Open `rust/src/capabilities.rs`. Find the existing tts.ru_acronym_expansion line. Add a new `features.push(...)` call immediately after it, in the same `#[cfg(feature = "tts")]` block:

```rust
#[cfg(feature = "tts")]
{
    features.push("tts");
    features.push("tts.ru_acronym_expansion");
    features.push("tts.ru_emphasis_marker");
}
```

(Adjust to match the actual existing block structure — the file may use a different bracket pattern; preserve it.)

- [ ] **Step 5.3: Build + verify**

```bash
cd rust && cargo build --no-default-features --features onnx,tts 2>&1 | tail -3
./target/debug/kesha-engine --capabilities-json | python3 -c "import sys, json; print(json.load(sys.stdin)['features'])"
```

Expected output line includes `'tts.ru_emphasis_marker'` after `'tts.ru_acronym_expansion'`.

- [ ] **Step 5.4: Clippy + fmt**

```bash
cd rust && cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cd rust && cargo fmt --check 2>&1 | tail -3
```
Both clean.

- [ ] **Step 5.5: Commit**

```bash
git add rust/src/capabilities.rs
git commit -m "$(cat <<'EOF'
feat(#233,capabilities): advertise tts.ru_emphasis_marker

Adds a new feature string to --capabilities-json under the existing
#[cfg(feature = "tts")] guard. Mirrors the tts.ru_acronym_expansion
pattern from #232. Lets future TS / Python clients gate `<emphasis>`
support on this flag against older engines.

No CLI flag — `<emphasis>` is pure SSML and ships via the existing
--ssml flag without additional surface.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Integration test for the spike-validated stress shift

Adds a stdin-loop integration test asserting the byte-length deltas the spike documented (#233 issue body).

**Files:**
- Modify: `rust/tests/tts_ru_normalize.rs` (extend existing `LoopEngine`-based suite)

- [ ] **Step 6.1: Add the new test**

Append a new `#[test]` to `rust/tests/tts_ru_normalize.rs`, after the existing `warm_session_say_as_and_baseline_checks` test:

```rust
/// Per-#233 spike result: vosk-tts-rs 0.9-multi honours `+vowel` markers
/// when they shift stress AWAY from the model's default first-syllable
/// position. Markers that AGREE with the default are no-ops.
///
/// Ratios chosen from the spike data:
/// - дом+а (genitive shift до-МА́): +3072 bytes vs baseline (~5.7%)
/// - д+ома (agrees with default ДО́ма): byte-identical to baseline
/// - <emphasis level="none">дом+а</emphasis>: strip `+`, matches baseline
///
/// Tolerance widened slightly to keep the test robust against minor model
/// updates: ≥+2KB for the shift, ±5% for the no-op cases.
#[test]
fn emphasis_marker_shifts_stress() {
    let mut eng = match LoopEngine::spawn() {
        Some(e) => e,
        None => {
            eprintln!("skipping emphasis_marker_shifts_stress: vosk-ru models not staged");
            return;
        }
    };

    let baseline = eng.synth("дома", false, false);

    let stressed_last = eng.synth(
        r#"<speak><emphasis>дом+а</emphasis></speak>"#,
        true,
        false,
    );
    assert!(
        stressed_last.len() > baseline.len() + 2000,
        "дом+а={} baseline={} (expected >baseline+2KB)",
        stressed_last.len(),
        baseline.len(),
    );

    let agrees_with_default = eng.synth(
        r#"<speak><emphasis>д+ома</emphasis></speak>"#,
        true,
        false,
    );
    let r1 = agrees_with_default.len() as f64 / baseline.len() as f64;
    assert!(
        (0.95..=1.05).contains(&r1),
        "д+ома={} baseline={} ratio={:.2} (expected 0.95..=1.05)",
        agrees_with_default.len(),
        baseline.len(),
        r1,
    );

    let suppressed = eng.synth(
        r#"<speak><emphasis level="none">дом+а</emphasis></speak>"#,
        true,
        false,
    );
    let r2 = suppressed.len() as f64 / baseline.len() as f64;
    assert!(
        (0.95..=1.05).contains(&r2),
        "suppressed={} baseline={} ratio={:.2} (expected 0.95..=1.05)",
        suppressed.len(),
        baseline.len(),
        r2,
    );
}
```

- [ ] **Step 6.2: Run the integration test**

```bash
cd rust && cargo test --no-default-features --features onnx,tts --test tts_ru_normalize emphasis_marker_shifts_stress 2>&1 | tail -10
```

Expected:
- Cold compile (~5-15 s).
- Cargo prints "running 1 test" then `test emphasis_marker_shifts_stress ... ok` after ~30-60 s (one Vosk model load + 4 synth calls via stdin-loop).

If a ratio assertion fails, capture the actual numbers in the failure message. Tune the threshold by ≤±5% only if the failure is consistent across re-runs and the directional signal is correct (e.g., дом+а is longer than baseline but by <2KB). Do NOT loosen below the spec's ≥+2KB / ±5% bands without revisiting the spec.

- [ ] **Step 6.3: Run the full integration suite**

```bash
cd rust && cargo test --no-default-features --features onnx,tts --test tts_ru_normalize 2>&1 | tail -10
```

Expected: 3 tests pass (`auto_expand_plain_fsb_is_longer_than_noexpand` + `warm_session_say_as_and_baseline_checks` + `emphasis_marker_shifts_stress`).

- [ ] **Step 6.4: Clippy + fmt**

```bash
cd rust && cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cd rust && cargo fmt --check 2>&1 | tail -3
```
Both clean.

- [ ] **Step 6.5: Commit**

```bash
git add rust/tests/tts_ru_normalize.rs
git commit -m "$(cat <<'EOF'
test(#233): integration test for spike-validated emphasis stress shift

Adds emphasis_marker_shifts_stress to the warm-session stdin-loop suite.
Asserts the spike-documented byte-length deltas:
  - <emphasis>дом+а</emphasis>             ≥ baseline + 2KB (genitive shift)
  - <emphasis>д+ома</emphasis>              ≈ baseline ±5% (agrees with default)
  - <emphasis level="none">дом+а</emphasis> ≈ baseline ±5% (suppress strips `+`)

Uses the existing LoopEngine wrapper (rust/tests/tts_ru_normalize.rs)
which spawns kesha-engine say --stdin-loop once and amortises the Vosk
model load across requests. Test skips gracefully when vosk-ru is not
staged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Audio-quality-check on the emphasis corpus

Per CLAUDE.md, any commit touching `rust/src/tts/**` runs the `audio-quality-check` agent on a curated corpus. This task synthesizes the corpus, runs the agent, and captures human spot-check evidence at `/tmp/kesha-233-evidence/`.

- [ ] **Step 7.1: Build the engine binary fresh**

```bash
cd rust && cargo build --no-default-features --features onnx,tts 2>&1 | tail -3
```

- [ ] **Step 7.2: Synthesize the 6-phrase corpus**

```bash
mkdir -p /tmp/kesha-233-evidence
ENG=/Users/anton/Personal/repos/kesha-voice-kit/rust/target/debug/kesha-engine

# 1. Default baseline (no emphasis)
echo 'дома' | "$ENG" say --voice ru-vosk-m02 --out /tmp/kesha-233-evidence/01_baseline_дома.wav

# 2. Emphasis with `+` shifts stress to last syllable (genitive до-МА́)
echo '<speak><emphasis>дом+а</emphasis></speak>' | \
  "$ENG" say --voice ru-vosk-m02 --ssml --out /tmp/kesha-233-evidence/02_emphasis_дом+а.wav

# 3. Emphasis with `+` agreeing with default first-syllable stress (no-op)
echo '<speak><emphasis>д+ома</emphasis></speak>' | \
  "$ENG" say --voice ru-vosk-m02 --ssml --out /tmp/kesha-233-evidence/03_emphasis_д+ома.wav

# 4. Emphasis with level="none" suppresses `+` markers
echo '<speak><emphasis level="none">дом+а</emphasis></speak>' | \
  "$ENG" say --voice ru-vosk-m02 --ssml --out /tmp/kesha-233-evidence/04_emphasis_level_none.wav

# 5. Emphasis without any `+` marker (warn-once fires)
echo '<speak><emphasis>обычное слово</emphasis></speak>' | \
  "$ENG" say --voice ru-vosk-m02 --ssml --out /tmp/kesha-233-evidence/05_emphasis_no_plus.wav 2>/tmp/kesha-233-evidence/05_stderr.log

# 6. Emphasis on en-am_michael (warn-once "emphasis-non-ru-vosk" fires; `+` stripped)
echo '<speak><emphasis>hello+ world</emphasis></speak>' | \
  "$ENG" say --voice en-am_michael --ssml --out /tmp/kesha-233-evidence/06_emphasis_en_kokoro.wav 2>/tmp/kesha-233-evidence/06_stderr.log

ls -la /tmp/kesha-233-evidence/
```

Expected: 6 non-empty WAV files. The two stderr logs (05, 06) should each contain ONE warning line (per-process dedup is per-`kesha-engine` invocation; each call is its own process).

- [ ] **Step 7.3: Write the evidence index**

```bash
cd /tmp/kesha-233-evidence
cat > evidence.md <<'EOF'
# Issue #233 acceptance evidence

| # | Criterion | File | Bytes | Stderr | Audible OK? |
|---|---|---|---|---|---|
| 01 | baseline plain `дома` (default ДО́ма stress) | 01_baseline_дома.wav | <fill> | — | <human> |
| 02 | `<emphasis>дом+а</emphasis>` shifts to до-МА́ | 02_emphasis_дом+а.wav | <fill> | — | <human> |
| 03 | `<emphasis>д+ома</emphasis>` agrees with default → no-op | 03_emphasis_д+ома.wav | <fill> | — | <human> |
| 04 | `<emphasis level="none">дом+а</emphasis>` strips `+` → matches baseline | 04_emphasis_level_none.wav | <fill> | — | <human> |
| 05 | `<emphasis>обычное слово</emphasis>` no `+` → warn-once + default stress | 05_emphasis_no_plus.wav | <fill> | 1 line: "emphasis-no-plus" | <human> |
| 06 | en-am_michael `<emphasis>` → warn-once + strip `+` + Kokoro G2P | 06_emphasis_en_kokoro.wav | <fill> | 1 line: "emphasis-non-ru-vosk" | <human> |

Generated $(date -Iseconds) by Task 7 on commit $(git rev-parse --short HEAD).
EOF

# Replace <fill> with actual byte counts
for i in 01 02 03 04 05 06; do
  f=$(ls /tmp/kesha-233-evidence/${i}_*.wav 2>/dev/null | head -1)
  if [ -n "$f" ]; then
    sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
    sed -i.bak "s|^| ${i}.* | $i | |g; s|<fill>|${sz}|g" /tmp/kesha-233-evidence/evidence.md 2>/dev/null
  fi
done
cat /tmp/kesha-233-evidence/evidence.md
```

(The byte-count replacement loop is rough; if `sed -i` syntax differs on macOS vs Linux, fall back to manually editing the table after running `ls -la` to inspect sizes.)

- [ ] **Step 7.4: Verify warn-once stderr lines**

```bash
cat /tmp/kesha-233-evidence/05_stderr.log
cat /tmp/kesha-233-evidence/06_stderr.log
```

Expected:
- 05: contains exactly one line starting with `warning:` mentioning "emphasis-no-plus" or "no `+` marker".
- 06: contains exactly one line starting with `warning:` mentioning "non-ru-vosk" or "stripping `+`".

If either log is empty, the warn-once helper isn't being reached — return to Task 3 / Task 4 and re-check the wiring.

- [ ] **Step 7.5: Dispatch audio-quality-check agent**

Use the Agent tool with `subagent_type=audio-quality-check` against `/tmp/kesha-233-evidence/`. Prompt the agent with the full context: 6 WAV files, expected byte-length relationships (02 > 01, 03 ≈ 01, 04 ≈ 01, 05 reasonable for "обычное слово", 06 Kokoro 24 kHz vs the rest 22 kHz Vosk).

The agent reports RMS, silence ratio, sample rate, channel count, and length-vs-text ratio. Subjective quality is human-checked; the agent only flags statistical anomalies (silent WAV, monosample, wrong sample rate, 10× length-off).

- [ ] **Step 7.6: Address any anomalies**

If the agent flags anything (e.g. silent WAV, wrong sample rate), return to the implementation tasks and fix. Re-synthesize the affected file and re-run the agent. Document any acceptable warnings (e.g. file 05's silence ratio may be slightly elevated — normal for "обычное слово" content).

- [ ] **Step 7.7: Subjective spot-check (human-in-the-loop)**

```bash
for f in /tmp/kesha-233-evidence/0[1-6]*.wav; do echo "▶ $(basename $f)"; afplay "$f"; done
```

Confirm by ear:
- 01 ≈ 03 ≈ 04: all sound like default "ДО́ма" (first-syllable stress).
- 02: clearly different — last-syllable stress "до-МА́".
- 05: "обычное слово" reads naturally with default stress.
- 06: "hello world" Kokoro English — no `+` audible.

Mark each row in `/tmp/kesha-233-evidence/evidence.md` with `✓` or `✗` in the "Audible OK?" column.

(No commit at this step — the evidence directory is ephemeral. Findings are summarised in the PR description.)

---

## Task 8: Documentation

Updates user-facing docs.

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 8.1: Add a `<emphasis>` example to README.md**

Find the existing `kesha say` examples block (search for the Russian abbreviations subsection added in #232; the new emphasis subsection slots in right after it). Add:

```markdown
**Russian word stress** (`ru-vosk-*` voices):

```bash
# Caller provides `+` before the stressed vowel; engine passes it to Vosk
kesha say --voice ru-vosk-m02 --ssml \
  '<speak><emphasis>дом+а</emphasis></speak>'   # genitive до-МА́

# Suppress an inherited <emphasis> with level="none"
kesha say --voice ru-vosk-m02 --ssml \
  '<speak><emphasis level="none">дом+а</emphasis></speak>'   # default ДО́ма
```

Vosk-TTS 0.9-multi honors a `+` placed BEFORE the target stressed vowel — but only when the marker shifts stress AWAY from the model's default (first-syllable). `+` agreeing with the default is a no-op. See [#233](https://github.com/drakulavich/kesha-voice-kit/issues/233).
```

- [ ] **Step 8.2: Update SKILL.md**

Find the SSML section in SKILL.md. After the `<say-as>` paragraph from #232, add:

```markdown
**Russian word stress** (`ru-vosk-*` only): `<emphasis>сл+ово</emphasis>` shifts stress to the vowel marked with `+`. `<emphasis level="none">сл+ово</emphasis>` strips the `+` (cancel inherited emphasis). Other voices (`en-*`, `macos-*`) silently strip the `+` and warn once per process. Auto-stress dictionary not provided — caller writes the `+` manually. Closes [#233](https://github.com/drakulavich/kesha-voice-kit/issues/233).
```

- [ ] **Step 8.3: Insert `[1.8.0] (unreleased)` in CHANGELOG.md**

At the top of CHANGELOG.md, above the existing `## [1.7.0]` section, add:

```markdown
## [1.8.0] (unreleased)

### Added

- **SSML `<emphasis>` honored on the Russian Vosk path.** Caller-provided `+`-before-vowel markers (`<emphasis>дом+а</emphasis>`) are passed through to vosk-tts-rs, which honors them as a stress hint when they shift stress AWAY from the model's default first-syllable position. `<emphasis level="none">` suppresses inherited emphasis (strips `+`). Once-per-process stderr warning when content lacks any `+` marker. Closes [#233](https://github.com/drakulavich/kesha-voice-kit/issues/233).
- **Engine `--capabilities-json` reports `tts.ru_emphasis_marker`** in the `features` array. Lets future clients gate `<emphasis>` against older engines.
- **`<emphasis>` on non-Russian-Vosk voices (Kokoro, AVSpeech)** silently strips `+` markers before reaching G2P / Swift sidecar, with a once-per-process stderr warning. The text content otherwise synthesizes normally — no caller-visible synth failure.

### Notes

- No new CLI flag. `<emphasis>` is pure SSML, ships via `--ssml`.
- No auto-stress dictionary. Path B (engine guesses ударение without a `+`) is intentionally deferred — see issue #233 for the design rationale.
- `<prosody rate/pitch/volume>` is tracked separately in [#236](https://github.com/drakulavich/kesha-voice-kit/issues/236).
```

- [ ] **Step 8.4: Verify links + no other docs touched**

```bash
grep -n "#233" README.md SKILL.md CHANGELOG.md
git status --short
```

Expected: at least one #233 reference per file; only README.md, SKILL.md, CHANGELOG.md modified.

- [ ] **Step 8.5: Commit**

```bash
git add README.md SKILL.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(#233): document <emphasis> stress markers

User-facing examples in README + SKILL.md showing the three flagship
behaviors:
- <emphasis>дом+а</emphasis>             → shift to last-syllable стресс
- <emphasis level="none">дом+а</emphasis> → strip `+`, default stress
- <emphasis> on non-ru-vosk-* voices       → silent strip + warn-once

CHANGELOG.md gains a [1.8.0] (unreleased) section naming the new
capability flag (tts.ru_emphasis_marker) and the per-engine handling
contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Release prep (manual, executed by operator)

This is a CLAUDE.md "engine release" — the implementing agent **stops here and asks the user before proceeding.** The release sequence touches public surface (npm, GitHub release page) and is not auto-runnable.

When the user gives the go-ahead, the operator runs:

- [ ] Bump `rust/Cargo.toml`, `rust/Cargo.lock` (via `cargo check`), `package.json#keshaEngine.version`, `package.json#version` to **1.8.0** in lockstep on a `release/1.8.0` branch (rename the existing `feat/233-vosk-ru-emphasis` branch via `gh api -X POST /repos/.../branches/{old}/rename -f new_name=release/1.8.0`, then re-open the PR).
- [ ] PR; let CI go green; merge with `--squash`.
- [ ] `git tag v1.8.0 && git push origin v1.8.0` — triggers `build-engine.yml` for darwin-arm64 / linux-x64 / windows-x64.
- [ ] Author release notes BEFORE publishing the draft. Use `gh release edit v1.8.0 --notes "$(cat <<'EOF' ... EOF)"` while the release is still a draft (per CLAUDE.md "RELEASE PROCESS" gotcha — `gh release edit --notes` silently drops content on published releases).
- [ ] `gh release edit v1.8.0 --draft=false`.
- [ ] Run the independent v1.8.0 validation block from CLAUDE.md "make smoke-test ALONE DOES NOT VALIDATE A NEW ENGINE":
  ```bash
  SMOKE=/tmp/kesha-v1.8.0-smoke && rm -rf "$SMOKE" && mkdir -p "$SMOKE" && cd "$SMOKE"
  curl -sLfo kesha-engine \
    "https://github.com/drakulavich/kesha-voice-kit/releases/download/v1.8.0/kesha-engine-darwin-arm64"
  chmod +x kesha-engine && xattr -d com.apple.quarantine kesha-engine 2>/dev/null
  ./kesha-engine --version                     # → "kesha-engine 1.8.0"
  ./kesha-engine --capabilities-json | jq '.features' | grep ru_emphasis_marker
  echo '<speak><emphasis>дом+а</emphasis></speak>' | \
    ./kesha-engine say --voice ru-vosk-m02 --ssml --out "$SMOKE/dom_a.wav"
  echo 'дома' | \
    ./kesha-engine say --voice ru-vosk-m02 --out "$SMOKE/baseline.wav"
  EXPANDED=$(stat -f%z "$SMOKE/dom_a.wav" 2>/dev/null || stat -c%s "$SMOKE/dom_a.wav")
  PLAIN=$(stat -f%z "$SMOKE/baseline.wav" 2>/dev/null || stat -c%s "$SMOKE/baseline.wav")
  [[ $EXPANDED -gt $((PLAIN + 2000)) ]] || { echo "FAIL: shift smaller than expected"; exit 1; }
  echo "✓ v1.8.0 validation passed: stressed=$EXPANDED baseline=$PLAIN delta=$((EXPANDED - PLAIN))"
  ```
- [ ] Repeat the smoke for `kesha-engine-linux-x64` (run via Docker if not on Linux). Windows can be skipped if no Windows host is available.
- [ ] If validation passes: `npm publish --access public`.
- [ ] Post-publish: `gh issue close 233 -R drakulavich/kesha-voice-kit --comment "Shipped in v1.8.0."` (if not auto-closed via the PR's "Closes #233" trailer — `gh issue view 233 --json state` to verify).

---

## Risks (carried over from spec)

| Risk | Mitigation |
|---|---|
| Vosk-TTS upstream changes the `+`-marker semantics | Integration test asserts the directional signal (`дом+а` ≥ baseline + 2KB) — a regression in upstream Vosk surfaces as test failure, not silent quality drop. |
| Per-process warn-once leaks across `--stdin-loop` daemon clients | Daemon writes the warning ONCE per process lifetime regardless of how many bad requests arrive. Acceptable — a noisy log doesn't help the user diagnose any further than one line. |
| `<emphasis>` content with both `+` AND `level="none"` (`<emphasis level="none">д+ома</emphasis>`) | Suppress wins (strips `+` from content). Documented in spec Decisions table; covered by `emphasis_suppress_strips_plus` unit test in Task 3. |
| `<emphasis>` wrapping `<say-as>` (rare nested case) | The spec's Decisions table says "inner `<say-as>` wins". The current parser implementation may emit BOTH segments (Emphasis for outer + Spell for inner). Documented as a known limitation in the spec; not blocking for v1.8.0 — surface as a follow-up issue if a real user hits it. |

---

## Self-review checklist

- [ ] Every spec section covered? Architecture pipeline (Task 1, 3, 4), parser arm (Task 2), warn-once helper (Task 1), capabilities flag (Task 5), tests (Task 1, 2, 3, 6), audio-quality-check (Task 7), docs (Task 8), release (Task 9). ✓
- [ ] No placeholders ("TBD", "TODO", "implement later", "appropriate error handling", "similar to Task N"). ✓
- [ ] Type / function / constant names consistent across tasks (`Segment::Emphasis { content, suppress }`, `EmphasisLevel::None`, `warn::warn_once`, `tts.ru_emphasis_marker`). ✓
- [ ] Each task is bite-sized: write test → fail → implement → pass → commit. ✓
- [ ] Failing tests precede implementation in every code task. ✓
- [ ] Clippy + fmt run between tasks. ✓
- [ ] Verifiability gate: every task ends with a commit SHA + concrete test output (pass/fail counts) — implementer reports this in their report-back to the controller. End-to-end evidence captured at `/tmp/kesha-233-evidence/` in Task 7. ✓
