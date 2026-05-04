# Russian abbreviation handling for Vosk-TTS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Russian acronyms (ВОЗ → "вэ о зэ") for `ru-vosk-*` voices, both via SSML `<say-as interpret-as="characters">` and via auto-detect on plain text. Closes the readability complaint in #232; defers stress placement (`<emphasis>`) to #233.

**Architecture:** New Rust submodule `tts::ru` (acronym matcher + Cyrillic letter-name table) sits between SSML parsing and Vosk synth in the existing pipeline. The `Segment` enum gets a `Spell(String)` variant emitted only by `<say-as interpret-as="characters">`. `SayOptions.expand_abbrev` (default true) gates the auto-detect step; `<say-as>` is honored unconditionally. CLI flag `--no-expand-abbrev` and `tts.ru_acronym_expansion` capability complete the surface.

**Tech Stack:** Rust 2024, `ssml-parser` 0.1.4, existing `vosk-tts-rs` synth path, clap, Bun/TypeScript CLI passthrough.

**Spec:** `docs/superpowers/specs/2026-05-03-vosk-ru-acronym-expansion-design.md` (commit 2c8bdc7).

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `rust/src/tts/ssml.rs` | MODIFY | Add `Segment::Spell(String)` variant; emit it for `<say-as interpret-as="characters">`; other tags unchanged. |
| `rust/src/tts/ru/mod.rs` | NEW | Public surface: `pub fn normalize_segments(segs, auto_expand)`. Tiny router. |
| `rust/src/tts/ru/letter_table.rs` | NEW | `LETTERS` const + `pub(super) fn expand_chars(&str) -> String`. |
| `rust/src/tts/ru/acronym.rs` | NEW | `STOP_LIST` const + `pub(super) fn expand_acronyms(&str) -> String` + `is_acronym_token` helper. |
| `rust/src/tts/mod.rs` | MODIFY | Declare `pub mod ru`; add `expand_abbrev: bool` to `SayOptions`; thread through `say_with_vosk` and `synth_segments_vosk_with`. |
| `rust/src/main.rs` | MODIFY | Add `--no-expand-abbrev` clap arg on the `say` subcommand; populate `SayOptions.expand_abbrev`; add `tts.ru_acronym_expansion: true` to `--capabilities-json`. |
| `src/cli/say.ts` | MODIFY | Parse `--no-expand-abbrev`; forward to engine subprocess only when `getEngineCapabilities().features?.["tts.ru_acronym_expansion"]` is true. |
| `rust/tests/tts_ru_normalize.rs` | NEW | End-to-end test: byte-length deltas confirming auto-expand and `<say-as>` paths produce different audio than no-op. |
| `tests/unit/cli-say.test.ts` | MODIFY | Bun test that the `--no-expand-abbrev` flag round-trips to the engine arg list. |
| `README.md`, `SKILL.md`, `CHANGELOG.md` | MODIFY | User-facing docs: add Russian abbreviation example with both auto-detect and SSML forms. |

The new `ru/` submodule has only Russian-Vosk-specific logic. No changes to `kokoro.rs`, `vosk.rs` (synth), `voices.rs`, `audio.rs`.

---

## Pre-flight

Verify the working tree before starting:

- [ ] **Step 0.1: Confirm branch + spec**

Run:
```bash
git rev-parse --abbrev-ref HEAD
git log -1 --oneline -- docs/superpowers/specs/2026-05-03-vosk-ru-acronym-expansion-design.md
```
Expected: branch `feat/232-vosk-ru-acronym`, spec commit `2c8bdc7` on top.

- [ ] **Step 0.2: Confirm baseline tests + clippy**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts 2>&1 | tail -3
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
cargo fmt --check
```
Expected: all green. If anything fails, stop and investigate before adding new code on a broken base.

---

## Task 1: Extend `Segment` with `Spell` variant (no parser change yet)

Adds the variant; existing handlers pass it through as text so the codebase still compiles. The parser doesn't emit it yet.

**Files:**
- Modify: `rust/src/tts/ssml.rs:21-29` (Segment enum)
- Modify: `rust/src/tts/mod.rs:225-242` (synth_segments_kokoro_with match)
- Modify: `rust/src/tts/mod.rs:319-330` (synth_segments_vosk_with match)
- Test: `rust/src/tts/ssml.rs` inline `#[cfg(test)]`

- [ ] **Step 1.1: Write the failing test**

Add to the inline `#[cfg(test)] mod tests` in `rust/src/tts/ssml.rs`:

```rust
#[test]
fn segment_has_spell_variant() {
    // Ensure the variant exists and is constructible. Parser wiring lands in Task 2.
    let s = Segment::Spell("ВОЗ".to_string());
    match s {
        Segment::Spell(t) => assert_eq!(t, "ВОЗ"),
        _ => panic!("expected Segment::Spell"),
    }
}
```

- [ ] **Step 1.2: Run the test (will fail to compile)**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml::tests::segment_has_spell_variant 2>&1 | tail -5
```
Expected: compile error `no variant or associated item named 'Spell' found for enum 'Segment'`.

- [ ] **Step 1.3: Add the variant**

In `rust/src/tts/ssml.rs:21-29`:

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
    /// `tts::ru::letter_table::expand_chars`. Other engines pass it through as text
    /// (their G2P will read the cyrillic word verbatim — acceptable until per-engine
    /// support lands).
    Spell(String),
}
```

- [ ] **Step 1.4: Update existing `match` arms to handle `Spell` as text passthrough**

In `rust/src/tts/mod.rs::synth_segments_kokoro_with` (search for `ssml::Segment::Text(t) =>`), add `Spell` arm:

```rust
ssml::Segment::Text(t) | ssml::Segment::Spell(t) => {
    let ipa = g2p::text_to_ipa(t, lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    let audio = sess
        .infer_ipa(&ipa, voice_path, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    out.extend(audio);
}
```

In `rust/src/tts/mod.rs::synth_segments_vosk_with` (search for `ssml::Segment::Text(t) | ssml::Segment::Ipa(t) =>`), extend the OR pattern:

```rust
ssml::Segment::Text(t) | ssml::Segment::Ipa(t) | ssml::Segment::Spell(t) => {
    let (audio, _sr) = cache
        .infer(model_dir, t, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
    out.extend(audio);
}
```

These passthroughs are temporary — Task 7 routes `Spell` through `ru::normalize_segments` before the synth ever sees it.

- [ ] **Step 1.5: Run the new test + full ssml + tts test set**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml 2>&1 | tail -5
```
Expected: green; `segment_has_spell_variant` passes; all existing ssml tests still pass.

- [ ] **Step 1.6: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

- [ ] **Step 1.7: Commit**

```bash
git add rust/src/tts/ssml.rs rust/src/tts/mod.rs
git commit -m "$(cat <<'EOF'
feat(#232,tts): add Segment::Spell variant (no parser wiring yet)

Adds a new SSML segment variant for letter-by-letter spelling requests.
Existing Kokoro and Vosk segment handlers fall through to text-passthrough
so the codebase still compiles. The SSML parser is not yet emitting Spell;
that lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SSML parser emits `Spell` for `<say-as interpret-as="characters">`

Hooks the new variant into the parser. Other `interpret-as` values continue warn+strip.

**Files:**
- Modify: `rust/src/tts/ssml.rs:71-122` (the main `for span in &spans` loop)
- Modify: `rust/src/tts/ssml.rs` inline `#[cfg(test)] mod tests`

- [ ] **Step 2.1: Write the failing test**

Append to `rust/src/tts/ssml.rs` inside `mod tests`:

```rust
#[test]
fn say_as_characters_emits_spell_segment() {
    let segs = parse(r#"<speak><say-as interpret-as="characters">ВОЗ</say-as></speak>"#).unwrap();
    let spell_chunks: Vec<&str> = segs.iter().filter_map(|s| match s {
        Segment::Spell(t) => Some(t.as_str()),
        _ => None,
    }).collect();
    assert_eq!(spell_chunks, vec!["ВОЗ"]);
    // No stray text segments either side.
    let text_chunks = segs.iter().filter(|s| matches!(s, Segment::Text(t) if !t.trim().is_empty())).count();
    assert_eq!(text_chunks, 0);
}

#[test]
fn say_as_cardinal_continues_warn_strip() {
    // interpret-as="cardinal" is not in scope for #232; keep current
    // warn + strip behavior so the inner text is still synthesized.
    let segs = parse(r#"<speak><say-as interpret-as="cardinal">123</say-as></speak>"#).unwrap();
    assert!(matches!(segs.first(), Some(Segment::Text(t)) if t.contains("123")));
    assert!(!segs.iter().any(|s| matches!(s, Segment::Spell(_))));
}

#[test]
fn say_as_without_interpret_as_continues_warn_strip() {
    // Missing required attribute → fall through to warn+strip; inner text preserved.
    let segs = parse(r#"<speak><say-as>literal</say-as></speak>"#).unwrap();
    assert!(matches!(segs.first(), Some(Segment::Text(t)) if t.contains("literal")));
    assert!(!segs.iter().any(|s| matches!(s, Segment::Spell(_))));
}
```

- [ ] **Step 2.2: Run; tests should fail**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml::tests::say_as 2>&1 | tail -10
```
Expected: 3 tests fail (all currently fall into the `other =>` warn+strip arm).

- [ ] **Step 2.3: Implement the SayAs match arm**

In `rust/src/tts/ssml.rs` inside the `for span in &spans` loop (currently at lines ~71-122), insert a new arm BEFORE the `other =>` catchall:

```rust
ParsedElement::SayAs(attrs) => {
    if attrs.interpret_as == "characters" {
        // Emit any pending text up to the tag, then a Spell segment for
        // the inner text. Cursor advances past the closing tag so we
        // don't double-emit the inner content as a Text fall-through.
        push_text_slice(&mut segments, &text, cursor, span.start);
        let inner: String = text[span.start..span.end].iter().collect();
        let trimmed = inner.trim().to_string();
        if !trimmed.is_empty() {
            segments.push(Segment::Spell(trimmed));
        }
        cursor = span.end;
    } else {
        // Other interpret-as values (cardinal, ordinal, date, telephone,
        // …) are out of scope for #232. Keep the established warn+strip
        // behavior; the inner text falls through as a Text segment.
        let key = format!("say-as[interpret-as={}]", attrs.interpret_as);
        if warned.insert(key) {
            eprintln!(
                "warning: SSML <say-as interpret-as=\"{}\"> is not supported — only \"characters\" is recognised; falling back to plain text",
                attrs.interpret_as
            );
        }
    }
}
```

- [ ] **Step 2.4: Run the parser tests + full module**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ssml 2>&1 | tail -5
```
Expected: all green, including the 3 new tests.

- [ ] **Step 2.5: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

- [ ] **Step 2.6: Commit**

```bash
git add rust/src/tts/ssml.rs
git commit -m "$(cat <<'EOF'
feat(#232,ssml): emit Spell for <say-as interpret-as="characters">

The parser now produces Segment::Spell(inner) for <say-as
interpret-as="characters">…</say-as>. Other interpret-as values
(cardinal, ordinal, date, …) continue to warn + strip with their
inner text passing through as Text. <say-as> with no interpret-as
attribute falls through to the existing unknown-tag handler.

Synth-side handling for Spell is currently passthrough (added in the
previous commit). The Russian-Vosk normalization step in tts::ru
(next commits) replaces Spell with letter-by-letter Text before the
synth runs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Cyrillic letter table (`tts::ru::letter_table`)

The deterministic letter-by-letter expander used both by `<say-as>` and the auto-detector.

**Files:**
- Create: `rust/src/tts/ru/mod.rs` (will be expanded in later tasks; just declares submodules for now)
- Create: `rust/src/tts/ru/letter_table.rs`
- Modify: `rust/src/tts/mod.rs:5-13` (declare `pub mod ru;`)

- [ ] **Step 3.1: Create skeleton submodule**

Create `rust/src/tts/ru/mod.rs`:

```rust
//! Russian-specific text normalization for the Vosk-TTS path.
//!
//! Two responsibilities — both pure text-in / text-out:
//! - `letter_table::expand_chars` — letter-by-letter spelling
//!   for `<say-as interpret-as="characters">`.
//! - `acronym::expand_acronyms` — auto-detect all-uppercase
//!   Cyrillic acronyms in plain text.
//!
//! `normalize_segments` (added in a later task) routes [`crate::tts::ssml::Segment`]
//! values through the appropriate primitive.

pub mod letter_table;
```

- [ ] **Step 3.2: Wire submodule into `tts::mod`**

Modify `rust/src/tts/mod.rs:5-13`. After existing `pub mod ssml;` add:

```rust
pub mod ru;
```

- [ ] **Step 3.3: Write the failing tests**

Create `rust/src/tts/ru/letter_table.rs`:

```rust
//! Cyrillic letter-name table for spelling-out abbreviations.
//!
//! Joined with single spaces (Vosk's BERT prosody behaves better on
//! space-separated tokens than on dash-joined ones). Ъ and Ь are
//! silent; their entries are kept in the table for completeness so the
//! match is exhaustive.

const LETTERS: &[(char, &str)] = &[
    ('а', "а"), ('б', "бэ"), ('в', "вэ"), ('г', "гэ"), ('д', "дэ"),
    ('е', "е"), ('ё', "ё"), ('ж', "жэ"), ('з', "зэ"), ('и', "и"),
    ('й', "ий"), ('к', "ка"), ('л', "эль"), ('м', "эм"), ('н', "эн"),
    ('о', "о"), ('п', "пэ"), ('р', "эр"), ('с', "эс"), ('т', "тэ"),
    ('у', "у"), ('ф', "эф"), ('х', "ха"), ('ц', "цэ"), ('ч', "че"),
    ('ш', "ша"), ('щ', "ща"), ('ъ', ""), ('ы', "ы"), ('ь', ""),
    ('э', "э"), ('ю', "ю"), ('я', "я"),
];

/// Expand `input` to space-separated Russian letter names.
/// Non-Cyrillic characters pass through unchanged. Silent letters
/// (Ъ, Ь) are dropped without leaving a double space.
pub(super) fn expand_chars(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    let mut first = true;
    for c in input.chars() {
        let lc = c.to_lowercase().next().unwrap_or(c);
        match LETTERS.iter().find(|(k, _)| *k == lc) {
            Some((_, "")) => {} // silent (Ъ, Ь)
            Some((_, name)) => {
                if !first {
                    out.push(' ');
                }
                out.push_str(name);
                first = false;
            }
            None => {
                if !first {
                    out.push(' ');
                }
                out.push(c);
                first = false;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voz_expands_to_three_letter_names() {
        assert_eq!(expand_chars("ВОЗ"), "вэ о зэ");
    }

    #[test]
    fn cska_expands_to_four_letter_names() {
        assert_eq!(expand_chars("ЦСКА"), "цэ эс ка");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(expand_chars(""), "");
    }

    #[test]
    fn yo_is_distinct_from_ye() {
        assert_eq!(expand_chars("ЁЛЬ"), "ё эль");
        assert_eq!(expand_chars("ЕЛЬ"), "е эль");
    }

    #[test]
    fn yat_is_silent_no_double_space() {
        // ОБЪЁМ would be word-shaped, but we still want a clean expansion if forced.
        assert_eq!(expand_chars("ОБЪЁМ"), "о бэ ё эм");
    }

    #[test]
    fn soft_sign_is_silent() {
        assert_eq!(expand_chars("МЬ"), "эм");
    }

    #[test]
    fn full_alphabet_round_trip() {
        // Each cyrillic letter must produce a non-empty token unless it's Ъ/Ь.
        let alphabet = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
        let result = expand_chars(alphabet);
        let pieces: Vec<&str> = result.split(' ').collect();
        // 33 letters minus the two silent (Ъ, Ь) = 31 audible tokens.
        assert_eq!(pieces.len(), 31, "got: {result}");
    }

    #[test]
    fn lowercase_input_works() {
        assert_eq!(expand_chars("воз"), "вэ о зэ");
    }

    #[test]
    fn non_cyrillic_passes_through() {
        // The matcher (Task 5) won't pass non-Cyrillic to us; this is a sanity guard
        // for explicit <say-as> with mixed input.
        assert_eq!(expand_chars("AБ1"), "A бэ 1");
    }
}
```

- [ ] **Step 3.4: Run; tests should pass**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ru::letter_table 2>&1 | tail -10
```
Expected: 9 tests pass.

- [ ] **Step 3.5: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

- [ ] **Step 3.6: Commit**

```bash
git add rust/src/tts/ru/mod.rs rust/src/tts/ru/letter_table.rs rust/src/tts/mod.rs
git commit -m "$(cat <<'EOF'
feat(#232,tts): add Cyrillic letter-name table for spell-out

Adds tts::ru::letter_table::expand_chars which maps Russian text to
space-separated letter names ("ВОЗ" → "вэ о зэ"). Й → "ий"; Ъ and Ь
are silent (dropped without leaving double spaces); non-Cyrillic
characters pass through unchanged.

Joiner is a single space — Vosk's BERT prosody handles
space-separated tokens better than dashes. The full alphabet is
exercised by tests; downstream tasks wire this into Segment::Spell
handling and the auto-detect path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Acronym matcher (`tts::ru::acronym`)

The text-level matcher: detect 2-5 letter all-uppercase Cyrillic tokens, run them through the letter table, preserve punctuation, skip stop-list members and Ъ/Ь-containing tokens.

**Files:**
- Create: `rust/src/tts/ru/acronym.rs`
- Modify: `rust/src/tts/ru/mod.rs` (re-export submodule)

- [ ] **Step 4.1: Add the submodule declaration**

In `rust/src/tts/ru/mod.rs`, add below the existing `pub mod letter_table;` line:

```rust
pub mod acronym;
```

- [ ] **Step 4.2: Write the failing tests + skeleton**

Create `rust/src/tts/ru/acronym.rs`:

```rust
//! Auto-detect all-uppercase Cyrillic acronyms in plain text and replace
//! them with letter-by-letter spellings via `letter_table::expand_chars`.
//!
//! Rules (see spec 2026-05-03 §"Acronym matcher"):
//! 1. Tokenize on Unicode whitespace, preserving the original spacing.
//! 2. Strip a trailing run of `.,:;!?»)„"…—–-` to a `tail`; the rest is `core`.
//! 3. `core` must be 2..=5 chars, all `[А-ЯЁ]`, and not contain Ъ or Ь.
//! 4. `core` must not be in `STOP_LIST` (matches emphatic uppercase forms
//!    of common short Russian words like ОН, МЫ, КАК).
//! 5. Otherwise, replace the token with `expand_chars(core) + tail`.

use super::letter_table::expand_chars;

/// Common short Russian words that are sometimes written in CAPS for emphasis.
/// They look like acronyms to the matcher but are not. Length 2..=5 only —
/// shorter / longer is already filtered by the length rule.
const STOP_LIST: &[&str] = &[
    "ВСЁ", "ВЫ", "ДА", "ДЛЯ", "ЕЁ", "ЕМУ", "ЕЩЁ", "ИЛИ", "ИМ",
    "ИХ", "КАК", "КТО", "МНЕ", "МЫ", "НЕ", "НЕТ", "НИ", "ОН",
    "ОНА", "ОНИ", "ОНО", "ТОТ", "ТЫ", "УЖ", "ЧТО",
];

const TRAILING_PUNCT: &[char] = &[
    '.', ',', ':', ';', '!', '?', '»', ')', '„', '"', '…', '—', '–', '-',
];

/// Returns true if `core` is a candidate acronym worth expanding.
/// Pure structural check — does not consult the stop-list.
fn is_acronym_token(core: &str) -> bool {
    let len = core.chars().count();
    if !(2..=5).contains(&len) {
        return false;
    }
    for c in core.chars() {
        // Reject anything outside [А-ЯЁ] and any soft/hard sign.
        let in_range = ('А'..='Я').contains(&c) || c == 'Ё';
        if !in_range {
            return false;
        }
        if c == 'Ъ' || c == 'Ь' {
            return false;
        }
    }
    true
}

/// Auto-expand all-uppercase Cyrillic acronyms in `input`. Whitespace and
/// non-acronym tokens are preserved verbatim.
pub fn expand_acronyms(input: &str) -> String {
    // Iterate over (whitespace_run, token) pairs so the original spacing
    // is preserved exactly. split_inclusive doesn't help here because we
    // also need the leading whitespace; do it by hand.
    let mut out = String::with_capacity(input.len());
    let mut buf = String::new();
    let mut iter = input.chars().peekable();
    while let Some(c) = iter.next() {
        if c.is_whitespace() {
            // Flush pending token, then emit the whitespace.
            if !buf.is_empty() {
                out.push_str(&expand_token(&buf));
                buf.clear();
            }
            out.push(c);
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        out.push_str(&expand_token(&buf));
    }
    out
}

fn expand_token(token: &str) -> String {
    let (core, tail) = split_trailing_punct(token);
    if !is_acronym_token(core) {
        return token.to_string();
    }
    if STOP_LIST.iter().any(|w| *w == core) {
        return token.to_string();
    }
    let mut s = expand_chars(core);
    s.push_str(tail);
    s
}

/// Split `token` into (core, trailing_punct). Punctuation runs at the end
/// of the token are peeled off so a sentence-final acronym still expands.
fn split_trailing_punct(token: &str) -> (&str, &str) {
    let bytes = token.as_bytes();
    let mut end = token.len();
    for (idx, c) in token.char_indices().rev() {
        if TRAILING_PUNCT.contains(&c) {
            end = idx;
        } else {
            break;
        }
        let _ = bytes; // suppress unused-binding lint on retained reference
    }
    token.split_at(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Vec<(&'static str, &'static str)> {
        vec![
            // Spell out — 0 vowels (all consonants → always has a same-type adjacent pair).
            ("ФСБ", "эф эс бэ"),
            ("ФСБ.", "эф эс бэ."),
            ("ФСБ объявила", "эф эс бэ объявила"),
            ("СНГ", "сэ эн гэ"),
            ("МВД", "эм вэ дэ"),
            ("РЖД", "эр жэ дэ"),
            ("ВВП", "вэ вэ пэ"),
            // Spell out — consecutive vowels.
            ("ОАЭ", "о а э"),
            ("АЭС", "а эс"),
            // Spell out — consonant cluster adjacent to vowel.
            ("США", "сэ шэ а"),
            ("ЦСКА", "цэ эс ка"),
            // Spell out — length 2 (always spell regardless of structure).
            ("ИП", "и пэ"),
            ("ЕС", "е эс"),
            ("РФ", "эр эф"),
            // Don't spell — alternating CVC/CVCV (Vosk reads as word).
            ("ВОЗ", "ВОЗ"),
            ("КОТ", "КОТ"),
            ("НАТО", "НАТО"),
            ("ОПЕК", "ОПЕК"),
            // Stop-list preserved.
            ("ОН пришёл", "ОН пришёл"),
            ("МЫ идём", "МЫ идём"),
            // Inflected forms preserved.
            ("ВОЗа", "ВОЗа"),
            // Wrong shape preserved.
            ("дом", "дом"),
            ("НасА", "НасА"),
            ("NASA", "NASA"),
            ("В", "В"),
            ("АБВГДЕ", "АБВГДЕ"),
            // Soft/hard sign rejection.
            ("ОБЪЁМ", "ОБЪЁМ"),
            ("СЪЕЗД", "СЪЕЗД"),
            ("КРЕМЛЬ", "КРЕМЛЬ"),
            // Punctuation around a 0-vowel acronym.
            ("«ФСБ»", "«эф эс бэ»"),
            ("ФСБ! СНГ?", "эф эс бэ! сэ эн гэ?"),
            // Don't-spell tokens preserve their punct.
            ("ВОЗ.", "ВОЗ."),
            ("«НАТО»", "«НАТО»"),
        ]
    }

    #[test]
    fn matrix() {
        for (input, expected) in cases() {
            assert_eq!(expand_acronyms(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn every_stop_list_entry_round_trips() {
        for w in STOP_LIST {
            assert_eq!(expand_acronyms(w), *w, "stop-list entry escaped: {w}");
        }
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(expand_acronyms(""), "");
    }

    #[test]
    fn pure_whitespace_passes_through() {
        assert_eq!(expand_acronyms("   "), "   ");
        assert_eq!(expand_acronyms("\n"), "\n");
    }
}
```

- [ ] **Step 4.3: Run; tests should pass**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ru::acronym 2>&1 | tail -8
```
Expected: 4 tests pass (matrix is one #[test] iterating).

- [ ] **Step 4.4: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

If clippy flags `let _ = bytes;` in `split_trailing_punct` (it might), simplify by dropping the unused `bytes` binding entirely:

```rust
fn split_trailing_punct(token: &str) -> (&str, &str) {
    let mut end = token.len();
    for (idx, c) in token.char_indices().rev() {
        if TRAILING_PUNCT.contains(&c) {
            end = idx;
        } else {
            break;
        }
    }
    token.split_at(end)
}
```

- [ ] **Step 4.5: Commit**

```bash
git add rust/src/tts/ru/mod.rs rust/src/tts/ru/acronym.rs
git commit -m "$(cat <<'EOF'
feat(#232,tts): add Russian acronym auto-detector

Adds tts::ru::acronym::expand_acronyms which finds 2..=5 letter
all-uppercase Cyrillic tokens in plain text and replaces them with
letter-by-letter spellings via letter_table::expand_chars.

Rules baked in:
- length 2..=5 cyrillic uppercase
- reject tokens containing Ъ/Ь (filters emphatic uppercase forms of
  regular words like ОБЪЁМ, СЪЕЗД, КРЕМЛЬ)
- skip a hardcoded ~25-word stop-list (ОН, МЫ, ВЫ, КАК, ЧТО, …)
- preserve trailing punctuation (.,:;!?»)„"…—–-)
- pass through inflected forms (ВОЗа), Latin (NASA), and lowercase

Not yet wired into the synth path — that's the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `normalize_segments` glue in `tts::ru::mod`

Single entry point that callers (the Vosk synth paths) use to apply both primitives.

**Files:**
- Modify: `rust/src/tts/ru/mod.rs`

- [ ] **Step 5.1: Write failing tests**

Append to `rust/src/tts/ru/mod.rs`:

```rust
use crate::tts::ssml::Segment;

/// Normalize a segment list for the Russian Vosk path:
/// - `Spell(t)` → `Text(letter_table::expand_chars(t))`
/// - `Text(t)`  → `Text(acronym::expand_acronyms(t))` if `auto_expand`
/// - `Ipa(_)`, `Break(_)` → unchanged
///
/// `<say-as interpret-as="characters">` always wins (its content is the
/// inner text of a `Spell` segment by the time we get here, so the
/// `auto_expand` flag does not gate it).
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter()
        .map(|s| match s {
            Segment::Spell(t) => Segment::Text(letter_table::expand_chars(&t)),
            Segment::Text(t) if auto_expand => Segment::Text(acronym::expand_acronyms(&t)),
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn spell_segment_becomes_text_via_letter_table() {
        let out = normalize_segments(vec![Segment::Spell("ВОЗ".to_string())], false);
        assert_eq!(out, vec![Segment::Text("вэ о зэ".to_string())]);
    }

    #[test]
    fn text_runs_acronym_expansion_when_auto_expand_is_true() {
        let out = normalize_segments(
            vec![Segment::Text("ВОЗ объявила".to_string())],
            true,
        );
        assert_eq!(out, vec![Segment::Text("вэ о зэ объявила".to_string())]);
    }

    #[test]
    fn text_passes_through_when_auto_expand_is_false() {
        let out = normalize_segments(
            vec![Segment::Text("ВОЗ объявила".to_string())],
            false,
        );
        assert_eq!(out, vec![Segment::Text("ВОЗ объявила".to_string())]);
    }

    #[test]
    fn spell_wins_even_when_auto_expand_is_false() {
        // Confirms <say-as> isn't silenced by --no-expand-abbrev.
        let out = normalize_segments(vec![Segment::Spell("ОН".to_string())], false);
        assert_eq!(out, vec![Segment::Text("о эн".to_string())]);
    }

    #[test]
    fn break_and_ipa_pass_through() {
        let segs = vec![
            Segment::Break(Duration::from_millis(500)),
            Segment::Ipa("ɪpɑ".to_string()),
        ];
        assert_eq!(normalize_segments(segs.clone(), true), segs);
    }
}
```

- [ ] **Step 5.2: Run; tests should pass**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts ru::tests 2>&1 | tail -8
```
Expected: 5 tests pass.

- [ ] **Step 5.3: Clippy + fmt**

Run:
```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

- [ ] **Step 5.4: Commit**

```bash
git add rust/src/tts/ru/mod.rs
git commit -m "$(cat <<'EOF'
feat(#232,tts): add ru::normalize_segments router

Single entry point for the Russian Vosk normalization pass:
Spell → expand_chars (always), Text → expand_acronyms (when
auto_expand), Ipa/Break → unchanged. Callers in tts::mod gate the
auto_expand flag from SayOptions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Plumb `expand_abbrev` through `SayOptions` and the Vosk synth paths

Wires the new normalization step in front of the Vosk synth without changing other engines.

**Files:**
- Modify: `rust/src/tts/mod.rs:67-79` (`SayOptions` struct)
- Modify: `rust/src/tts/mod.rs::say` (line ~126-136: Vosk early-return branches)
- Modify: `rust/src/tts/mod.rs::say_with_vosk` and `synth_segments_vosk_with`
- Modify: any callers that construct `SayOptions` (search for `SayOptions {`)

- [ ] **Step 6.1: Find all SayOptions constructors**

Run:
```bash
grep -rn "SayOptions {" rust/ --include='*.rs'
```
Expected: handful of call sites in `rust/src/main.rs` and possibly tests.

- [ ] **Step 6.2: Add the field**

In `rust/src/tts/mod.rs:67-79`, extend the struct:

```rust
pub struct SayOptions<'a> {
    pub text: &'a str,
    /// espeak language code, e.g. `en-us`, `ru`.
    pub lang: &'a str,
    pub engine: EngineChoice<'a>,
    /// When true, `text` is parsed as SSML (issue #122). `<break>` tags yield
    /// silence of the declared duration; unknown tags are stripped with a warning.
    pub ssml: bool,
    /// Wire format for the returned bytes. Defaults to `Wav` so existing
    /// callers (and the historical `kesha say > out.wav` flow) stay
    /// bit-exact. See #223.
    pub format: OutputFormat,
    /// Auto-expand all-uppercase Cyrillic acronyms before Vosk synth (#232).
    /// Default `true`. `<say-as interpret-as="characters">` is always honored,
    /// regardless of this flag. No effect for non-`ru-vosk-*` voices.
    pub expand_abbrev: bool,
}
```

- [ ] **Step 6.3: Update `say()` Vosk branches to thread the flag**

In `rust/src/tts/mod.rs::say` (line ~126-136), update the Vosk early-return:

```rust
if let EngineChoice::Vosk {
    model_dir,
    speaker_id,
    speed,
} = &opts.engine
{
    if opts.ssml {
        return synth_segments_vosk(
            opts.text,
            model_dir,
            *speaker_id,
            *speed,
            opts.format,
            opts.expand_abbrev,
        );
    }
    return say_with_vosk(
        opts.text,
        model_dir,
        *speaker_id,
        *speed,
        opts.format,
        opts.expand_abbrev,
    );
}
```

- [ ] **Step 6.4: Update `say_with_vosk` signature + body**

```rust
fn say_with_vosk(
    text: &str,
    model_dir: &Path,
    speaker_id: u32,
    speed: f32,
    format: OutputFormat,
    expand_abbrev: bool,
) -> Result<Vec<u8>, TtsError> {
    let normalized = if expand_abbrev {
        ru::acronym::expand_acronyms(text)
    } else {
        text.to_string()
    };
    let mut cache = sessions::VoskCache::new();
    let (audio, sample_rate) = cache
        .infer(model_dir, &normalized, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
    encode_or_fail(&audio, sample_rate, format)
}
```

You'll need `pub` on `acronym::expand_acronyms` (currently `pub` already — confirm), and re-export at `rust/src/tts/ru/mod.rs`. `acronym` is already `pub mod acronym;`, so `crate::tts::ru::acronym::expand_acronyms` is reachable.

- [ ] **Step 6.5: Update `synth_segments_vosk` and `synth_segments_vosk_with`**

```rust
fn synth_segments_vosk(
    text: &str,
    model_dir: &Path,
    speaker_id: u32,
    speed: f32,
    format: OutputFormat,
    expand_abbrev: bool,
) -> Result<Vec<u8>, TtsError> {
    let segments =
        ssml::parse(text).map_err(|e| TtsError::SynthesisFailed(format!("ssml: {e}")))?;
    if segments.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "SSML had no speakable content".into(),
        ));
    }
    let segments = ru::normalize_segments(segments, expand_abbrev);
    let mut cache = sessions::VoskCache::new();
    synth_segments_vosk_with(&mut cache, &segments, model_dir, speaker_id, speed, format)
}
```

`synth_segments_vosk_with` itself doesn't need a new parameter — it operates on already-normalized segments. The `Spell(_)` arm we added in Task 1 becomes dead code in practice (because normalization always converts Spell→Text before this function runs); keep the arm but document it.

- [ ] **Step 6.6: Update all `SayOptions { … }` call sites to include `expand_abbrev: true`**

In `rust/src/main.rs` (search for `SayOptions {`), append `expand_abbrev: true` to each construction. Default is `true` matching the spec — auto-expand on by default.

If any tests construct `SayOptions` literally, add `expand_abbrev: true` there too.

- [ ] **Step 6.7: Build + run all TTS tests**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts tts:: 2>&1 | tail -10
```
Expected: all tests pass. The non-SSML and SSML Vosk paths now route through `ru::normalize_segments` for `ru-vosk-*` voices.

- [ ] **Step 6.8: Clippy + fmt**

```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

- [ ] **Step 6.9: Commit**

```bash
git add rust/src/tts/mod.rs rust/src/main.rs
git commit -m "$(cat <<'EOF'
feat(#232,tts): plumb expand_abbrev through Vosk synth paths

SayOptions gains expand_abbrev: bool (default true at call sites). The
Russian-Vosk synth paths (one-shot and SSML) now run inputs through
tts::ru::normalize_segments before reaching vosk-tts-rs. Other engines
(Kokoro, AVSpeech) are unaffected — they skip the ru:: layer entirely.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `--no-expand-abbrev` clap argument + capabilities-json flag

Exposes the engine surface the TS CLI will consume.

**Files:**
- Modify: `rust/src/main.rs` (the `say` subcommand args + `--capabilities-json` builder)

- [ ] **Step 7.1: Locate the say subcommand args struct**

Run:
```bash
grep -n "long = \"ssml\"" rust/src/main.rs
grep -n "capabilities-json" rust/src/main.rs
```
Expected: pointers to the `SayArgs`-like struct and the capabilities builder. Open both.

- [ ] **Step 7.2: Add the clap flag**

Inside the `say` subcommand args struct, add (next to `--ssml`):

```rust
/// Disable auto-expansion of Russian acronyms (ВОЗ → "вэ о зэ").
/// <say-as interpret-as="characters"> remains honored.
/// No effect for non-ru-vosk-* voices.
#[arg(long = "no-expand-abbrev", default_value_t = false)]
no_expand_abbrev: bool,
```

In the handler, populate `SayOptions`:

```rust
let opts = SayOptions {
    // …existing fields…
    expand_abbrev: !args.no_expand_abbrev,
};
```

- [ ] **Step 7.3: Add capability bit**

In the `--capabilities-json` builder, add to the `features` map:

```rust
features.insert("tts.ru_acronym_expansion".to_string(), serde_json::Value::Bool(true));
```

(Use whatever feature-map idiom the surrounding code already uses; match the existing pattern for, e.g., the OGG/Opus capability.)

- [ ] **Step 7.4: Build the engine + verify**

```bash
cd rust && cargo build --no-default-features --features onnx,tts 2>&1 | tail -3
./target/debug/kesha-engine --capabilities-json | jq '.features["tts.ru_acronym_expansion"]'
./target/debug/kesha-engine say --help | grep -A2 expand-abbrev
```
Expected: capability prints `true`; `--no-expand-abbrev` shows up in help.

- [ ] **Step 7.5: Smoke-test the flag end-to-end**

Run:
```bash
cd rust
echo "ВОЗ" | ./target/debug/kesha-engine say --voice ru-vosk-m02 --out /tmp/voz_expand.wav
echo "ВОЗ" | ./target/debug/kesha-engine say --voice ru-vosk-m02 --no-expand-abbrev --out /tmp/voz_noexpand.wav
ls -la /tmp/voz_expand.wav /tmp/voz_noexpand.wav
# Expand should be noticeably longer than no-expand (3 spelled letter names).
```

(This is a developer-loop check; the codified version is in Task 9 integration tests.)

- [ ] **Step 7.6: Clippy + fmt**

```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

- [ ] **Step 7.7: Commit**

```bash
git add rust/src/main.rs
git commit -m "$(cat <<'EOF'
feat(#232,cli): --no-expand-abbrev engine flag + capabilities entry

Adds the `--no-expand-abbrev` flag to `kesha-engine say` and surfaces
`tts.ru_acronym_expansion: true` in --capabilities-json so the TS CLI
can probe before forwarding the new flag against an older engine.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: TS CLI passthrough

Adds the same flag on the JS side and forwards it conditionally.

**Files:**
- Modify: `src/cli/say.ts`
- Test: `tests/unit/cli-say.test.ts`

- [ ] **Step 8.1: Locate the say flag definitions**

Run:
```bash
grep -n "ssml" src/cli/say.ts | head
grep -n "no-expand-abbrev\|expand-abbrev" src/cli/say.ts || echo "not yet present"
```
Expected: surrounding flag declarations visible in `src/cli/say.ts`.

- [ ] **Step 8.2: Write the failing test**

Append to `tests/unit/cli-say.test.ts` (or wherever existing flag-passthrough tests live; create the file if absent):

```typescript
import { describe, test, expect } from "bun:test";
import { buildSayArgs } from "../../src/cli/say";

describe("--no-expand-abbrev (#232)", () => {
  test("not present by default", () => {
    const args = buildSayArgs({
      voice: "ru-vosk-m02",
      out: "/tmp/x.wav",
      capabilities: { features: { "tts.ru_acronym_expansion": true } },
    });
    expect(args).not.toContain("--no-expand-abbrev");
  });

  test("forwarded when flag is set and engine supports it", () => {
    const args = buildSayArgs({
      voice: "ru-vosk-m02",
      out: "/tmp/x.wav",
      noExpandAbbrev: true,
      capabilities: { features: { "tts.ru_acronym_expansion": true } },
    });
    expect(args).toContain("--no-expand-abbrev");
  });

  test("dropped silently when engine lacks the capability", () => {
    const args = buildSayArgs({
      voice: "ru-vosk-m02",
      out: "/tmp/x.wav",
      noExpandAbbrev: true,
      capabilities: { features: {} },
    });
    expect(args).not.toContain("--no-expand-abbrev");
  });
});
```

If `src/cli/say.ts` does not currently expose a `buildSayArgs`-shaped helper, refactor the existing arg-construction to extract one (it should be there for `--bitrate` / `--sample-rate` already; otherwise extract the smallest function that covers the engine arg list).

- [ ] **Step 8.3: Run; tests should fail**

```bash
bun test tests/unit/cli-say.test.ts 2>&1 | tail -5
```
Expected: 3 failures.

- [ ] **Step 8.4: Implement the flag in `src/cli/say.ts`**

Extend the citty / commander definition with:

```typescript
"no-expand-abbrev": {
  type: "boolean",
  description:
    "Disable Russian acronym auto-expansion (ВОЗ → 'вэ о зэ') for ru-vosk-* voices. " +
    "<say-as interpret-as='characters'> still works. No effect for non-ru-vosk voices.",
},
```

In `buildSayArgs` (or its equivalent), append:

```typescript
const supportsExpand = capabilities?.features?.["tts.ru_acronym_expansion"] === true;
if (noExpandAbbrev && supportsExpand) {
  args.push("--no-expand-abbrev");
} else if (noExpandAbbrev && !supportsExpand) {
  // Older engine — silently drop. Aligns with the existing pattern used
  // for capability-gated flags like --bitrate. Debug-log so power users can
  // still see why the flag had no effect.
  log.debug?.(
    "kesha-engine does not advertise tts.ru_acronym_expansion; dropping --no-expand-abbrev",
  );
}
```

- [ ] **Step 8.5: Run; tests should pass**

```bash
bun test tests/unit/cli-say.test.ts 2>&1 | tail -5
```
Expected: 3 tests pass.

- [ ] **Step 8.6: Type check + full unit test set**

```bash
bunx tsc --noEmit 2>&1 | tail -3
bun test tests/unit/ 2>&1 | tail -5
```
Expected: clean; all units green.

- [ ] **Step 8.7: Commit**

```bash
git add src/cli/say.ts tests/unit/cli-say.test.ts
git commit -m "$(cat <<'EOF'
feat(#232,cli): TS forwards --no-expand-abbrev when engine supports it

Adds the `--no-expand-abbrev` flag to `kesha say`. The TS CLI checks
`engine --capabilities-json` for tts.ru_acronym_expansion before
forwarding; older engines drop the flag silently with a debug log,
matching how capability-gated flags like --bitrate already behave.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Integration test — byte-length deltas around the synth

End-to-end through the engine binary, comparing audio sizes for the auto-detect, no-op, and `<say-as>` paths.

**Files:**
- Create: `rust/tests/tts_ru_normalize.rs`

- [ ] **Step 9.1: Write the test**

Pattern after `rust/tests/tts_smoke.rs` for cache + model staging.

```rust
//! Issue #232 — Russian acronym auto-expansion + <say-as> integration.
//!
//! Asserts byte-length deltas through the full Vosk synth pipeline so a
//! regression in the new tts::ru layer (or in how SayOptions threads
//! `expand_abbrev`) shows up as a hard test failure rather than a
//! subjective audio change.

use std::path::PathBuf;

mod common;
use common::{stage_vosk_ru, KeshaCache};

fn synth(text: &str, ssml: bool, expand_abbrev: bool, cache: &KeshaCache) -> Vec<u8> {
    use kesha_engine::tts::{self, EngineChoice, OutputFormat, SayOptions};
    let model_dir = cache.vosk_dir();
    let opts = SayOptions {
        text,
        lang: "ru",
        engine: EngineChoice::Vosk {
            model_dir: &model_dir,
            speaker_id: 4, // m02 male
            speed: 1.0,
        },
        ssml,
        format: OutputFormat::Wav,
        expand_abbrev,
    };
    tts::say(opts).expect("synth ok")
}

#[test]
fn auto_expand_plain_voz_is_longer_than_noexpand() {
    let cache = KeshaCache::new();
    stage_vosk_ru(&cache);

    let expanded = synth("ВОЗ", /*ssml=*/ false, /*expand_abbrev=*/ true, &cache);
    let plain = synth("ВОЗ", /*ssml=*/ false, /*expand_abbrev=*/ false, &cache);

    // 3 spelled letter names; expect at least 1.3× audio bytes.
    let ratio = expanded.len() as f64 / plain.len() as f64;
    assert!(
        ratio > 1.3,
        "expanded={} plain={} ratio={:.2} (expected >1.3×)",
        expanded.len(),
        plain.len(),
        ratio,
    );
}

#[test]
fn say_as_characters_matches_auto_expand_within_tolerance() {
    let cache = KeshaCache::new();
    stage_vosk_ru(&cache);

    let auto = synth("ВОЗ", false, true, &cache);
    let ssml = synth(
        r#"<speak><say-as interpret-as="characters">ВОЗ</say-as></speak>"#,
        true,
        false, // <say-as> wins regardless of flag
        &cache,
    );

    let ratio = ssml.len() as f64 / auto.len() as f64;
    assert!(
        (0.9..=1.1).contains(&ratio),
        "auto={} ssml={} ratio={:.2} (expected 0.9..=1.1)",
        auto.len(),
        ssml.len(),
        ratio,
    );
}

#[test]
fn no_expand_baseline_matches_lowercase_form() {
    let cache = KeshaCache::new();
    stage_vosk_ru(&cache);

    let upper = synth("ВОЗ", false, false, &cache);
    let lower = synth("воз", false, false, &cache);

    // Both should be the synth's "voz" pronunciation; allow a wide
    // tolerance because Vosk's text normalizer might apply minor
    // differences for case.
    let ratio = upper.len() as f64 / lower.len() as f64;
    assert!(
        (0.7..=1.3).contains(&ratio),
        "upper={} lower={} ratio={:.2}",
        upper.len(),
        lower.len(),
        ratio,
    );
}
```

If `rust/tests/common/mod.rs` does not yet exist with `KeshaCache` + `stage_vosk_ru` helpers, mirror what `rust/tests/tts_smoke.rs` already does for staging — copy the same helper inline at the top of the new test file, and refactor into `common/mod.rs` only if duplication shows up in another integration test.

- [ ] **Step 9.2: Run the integration test**

Run:
```bash
cd rust && cargo test --no-default-features --features onnx,tts --test tts_ru_normalize 2>&1 | tail -10
```
Expected: 3 tests pass. If a ratio assertion fails, capture the actual numbers in the failure message and tune the threshold ±5%; do NOT loosen below ±10% without revisiting the spec.

- [ ] **Step 9.3: Clippy + fmt**

```bash
cd rust && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check
```
Expected: clean.

- [ ] **Step 9.4: Commit**

```bash
git add rust/tests/tts_ru_normalize.rs rust/tests/common/mod.rs
git commit -m "$(cat <<'EOF'
test(#232): integration tests for Russian acronym normalization

Exercises tts::say() end-to-end with voice=ru-vosk-m02:
- auto-expanded "ФСБ" produces ≥1.3× the audio bytes of the no-op path
- <say-as interpret-as="characters">ВОЗ</say-as> matches auto-expand
  within ±10%
- no-expand baseline matches lowercase form within ±30%

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Audio quality check on the 20-phrase corpus

Per CLAUDE.md, any commit touching `rust/src/tts/**` runs the `audio-quality-check` agent on a pre-defined corpus.

- [ ] **Step 10.1: Build the corpus**

Create `/tmp/kesha-232-corpus/` and synthesize 20 WAVs:

```bash
mkdir -p /tmp/kesha-232-corpus && cd /tmp/kesha-232-corpus
# 10 abbreviations
for w in ВОЗ ФСБ СНГ НАТО США ЦСКА ЦБ МВД РЖД ОПЕК; do
  echo "$w объявила решение" | kesha say --voice ru-vosk-m02 --out "abbrev_${w}.wav"
done
# 5 stop-list controls (must NOT be expanded)
for w in ОН КОТ ВЫ ЕЁ КАК; do
  echo "$w пришёл рано" | kesha say --voice ru-vosk-m02 --out "stop_${w}.wav"
done
# 5 plain-text controls (no acronyms)
i=0
for s in "Сегодня солнечно" "Я люблю кофе" "Книга лежит на столе" "Время летит быстро" "Утро началось рано"; do
  i=$((i+1))
  echo "$s" | kesha say --voice ru-vosk-m02 --out "plain_${i}.wav"
done
ls -la /tmp/kesha-232-corpus/
```

Expected: 20 WAVs, all non-empty, mono 22050 Hz.

- [ ] **Step 10.2: Dispatch audio-quality-check agent**

Use the Agent tool with `subagent_type=audio-quality-check` against `/tmp/kesha-232-corpus/`. The agent reports RMS, silence ratio, sample rate, channel count, and length-vs-text ratio.

- [ ] **Step 10.3: Address any anomalies**

If any WAV is silent, monosample, off-rate, or 10× length-off, fix before continuing. Document the fix in the PR description.

- [ ] **Step 10.4: Subjective spot-check (human-in-the-loop)**

Listen to 3 representative WAVs (one abbrev, one stop-list, one plain). They must sound right. This is the part audio-quality-check intentionally doesn't gate on; do not skip it.

(No commit at this step — corpus is ephemeral. Findings go in the PR description.)

---

## Task 11: Documentation

User-facing surface change → docs update.

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 11.1: README — add a Russian abbreviation example**

Find the existing `kesha say` examples block. Add (with the spec's three flagship cases):

```markdown
**Russian abbreviations** (`ru-vosk-*` voices):

```bash
# Auto-detect on by default — ВОЗ reads as "вэ-о-зэ"
kesha say --voice ru-vosk-m02 'ВОЗ объявила пандемию.'

# Force a literal reading
kesha say --voice ru-vosk-m02 --no-expand-abbrev 'ВОЗ.'

# Explicit SSML control (overrides the stop-list)
kesha say --voice ru-vosk-m02 --ssml \
  '<speak><say-as interpret-as="characters">ОН</say-as> пришёл</speak>'
```
```

- [ ] **Step 11.2: SKILL.md — note the new flag + capability**

In the SKILL.md TTS section, add the same example and a one-line note:

> ru-vosk-* voices auto-expand all-uppercase Cyrillic acronyms (length 2–5, with a stop-list of common short words). Disable per call with `--no-expand-abbrev` or override per-token via SSML `<say-as interpret-as="characters">`.

- [ ] **Step 11.3: CHANGELOG.md — start the v1.7.0 stub**

Top of CHANGELOG.md:

```markdown
## v1.7.0 (unreleased)

### Added
- Russian abbreviation auto-expansion for `ru-vosk-*` voices ("ВОЗ" → "вэ-о-зэ"). Opt-out via `--no-expand-abbrev`. Closes #232.
- SSML `<say-as interpret-as="characters">…</say-as>` honored on the Russian Vosk path. Other `interpret-as` values continue warn+strip.
- Engine `--capabilities-json` now reports `tts.ru_acronym_expansion: true`.
```

- [ ] **Step 11.4: Verify links**

Run:
```bash
grep -n "#232" README.md SKILL.md CHANGELOG.md
```
Expected: at least one hit per file.

- [ ] **Step 11.5: Commit**

```bash
git add README.md SKILL.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(#232): document Russian abbreviation handling

User-facing examples in README + SKILL.md showing the auto-detect
default, --no-expand-abbrev opt-out, and SSML <say-as> override.
CHANGELOG.md gains a v1.7.0 stub.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Release prep (executed manually, not by the implementing agent)

This is a CLAUDE.md "engine release" — operator runs it after the implementation PR merges.

- [ ] Bump `rust/Cargo.toml`, `rust/Cargo.lock` (via `cargo check`), `package.json#keshaEngine.version`, `package.json#version` to **1.7.0** in lockstep on a `release/1.7.0` branch.
- [ ] PR; let CI go green; merge.
- [ ] `git tag v1.7.0 && git push origin v1.7.0` — triggers `build-engine.yml` for darwin/linux/windows.
- [ ] `gh release edit v1.7.0 --notes` BEFORE publishing the draft (CLAUDE.md "RELEASE PROCESS" gotcha — `gh` silently drops body content if you edit a published release with `--notes`).
- [ ] `gh release edit v1.7.0 --draft=false`.
- [ ] Run the independent v1.7.0 validation block from CLAUDE.md ("`make smoke-test` ALONE DOES NOT VALIDATE A NEW ENGINE") — download all three platform binaries, exercise `kesha-engine say --voice ru-vosk-m02` on a real abbreviation, confirm WAV is non-trivial, repeat for linux via Docker.
- [ ] If validation passes: `npm publish --access public`.

---

## Risks (carried over from spec)

| Risk | Mitigation |
|---|---|
| Stop-list misses some emphatic CAPS word → false positive | Stop-list is hardcoded; adding entries is a 1-line PR. Track user reports. |
| Performance on long inputs | Matcher is single-pass char iteration; benchmark only if a real input shows up >1ms. |
| Й = "ий" subjective | One constant; trivially re-baseline if multiple users dislike. |
| Vosk responds differently to space-separated letter names than expected | Spike compared "ВОЗ" vs "вэ о зэ" already during brainstorm; the new audio is audibly the spelled form. Integration test guards the byte-length delta. |
| TS CLI ↔ engine version skew | Capability gate (`tts.ru_acronym_expansion` in --capabilities-json). Older engines silently drop the flag. |

---

## Self-review checklist

- [ ] Every spec section covered? Architecture pipeline (Task 6), letter table (3), acronym matcher (4), normalize_segments (5), SSML interaction matrix (2 + 5), CLI surface (7 + 8), capabilities (7), tests (3, 4, 5, 9), audio-quality-check (10), docs (11), release (12). ✓
- [ ] No placeholders ("TBD", "TODO", "implement later", "appropriate error handling", "similar to Task N"). ✓
- [ ] Type / function / constant names consistent across tasks (`expand_chars`, `expand_acronyms`, `is_acronym_token`, `STOP_LIST`, `LETTERS`, `normalize_segments`, `SayOptions::expand_abbrev`, `--no-expand-abbrev`, `tts.ru_acronym_expansion`). ✓
- [ ] Each task is bite-sized: write test → fail → implement → pass → commit. ✓
- [ ] Failing tests precede implementation in every code task. ✓
- [ ] Clippy + fmt run between tasks. ✓
