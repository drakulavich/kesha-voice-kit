# Russian stress placement via SSML `<emphasis>` for Vosk-TTS

**Date:** 2026-05-05
**Status:** Approved (sections 1-5, brainstormed with maintainer)
**Issue:** #233 (this spec)
**Related:** #232 (closed, shipped in v1.7.0); #236 (`<prosody>` follow-up)
**Branch:** `feat/233-vosk-ru-emphasis` (to be created)

## Problem

Vosk-TTS 0.9-multi places stress on the first vowel of each Russian word by default. For words where canonical Russian stress lies on a later syllable, the synth either gets the stress wrong (`за́мок` vs `замо́к`) or reads in a flat, unnatural way. SSML `<emphasis>` is the standard hint for stress, but our parser currently treats `<emphasis>` as a known-but-unsupported tag — it warns to stderr and strips the tag while passing the inner text through unchanged.

The spike (recorded in #233) confirms Vosk-TTS 0.9-multi honors a `+` placed BEFORE a target stressed vowel — but only when the marker shifts stress AWAY from the model's default. `+` agreeing with the default is a no-op.

## Goal

For voice id prefix `ru-vosk-*`:

1. Honor `<emphasis>` content with caller-provided `+`-markers — the marker is preserved through the SSML pipeline and reaches Vosk verbatim.
2. Support `<emphasis level="none">` to suppress an inherited emphasis — strip `+` markers from the inner text before synth.
3. Warn once per process when `<emphasis>` content lacks any `+` — caller has provided no actionable hint.
4. On non-Russian-Vosk voices (Kokoro, AVSpeech), `<emphasis>` content has its `+` markers stripped before reaching G2P / Swift sidecar (which would otherwise choke). One warn per process.

Out of scope:

- `<prosody rate/pitch/volume>` → tracked separately in #236.
- Auto-stress dictionary (the "user writes plain Russian, engine guesses ударение") — defer to a future issue if user reports demand. Current rule: caller provides `+` or it's a no-op.
- Multi-word `<emphasis>` content with mixed `+` / no-`+` words — pass through verbatim per-word; Vosk handles `+`-marked words and uses default stress on the rest.
- Per-engine pitch / volume control — handled by #236 if at all.
- `<emphasis>` on Latin / non-Cyrillic content — pass-through, Vosk reads as words.

## Decisions (from brainstorm)

| Question | Decision | Rationale |
|---|---|---|
| Scope | **`<emphasis>` only** | Closes #233; `<prosody>` is a different shape (per-segment speed/pitch/volume), spike not yet done — split out into #236 |
| `level="none"` handling | **Strip `+` from inner text** | SSML composition: caller can override an inherited `<emphasis>` by wrapping a sub-tree in `level="none"` |
| `level="reduced/moderate/strong"` | **All collapsed to "honor `+`"** | Vosk has only one stress marker; preserving SSML 4-level granularity needs prosody-level synth control we don't have |
| Warning frequency | **Once per process via `OnceLock<Mutex<HashSet<&'static str>>>`** | Existing parser pattern (`warned: HashSet<String>`) is local to one parse; we need cross-call dedup at the synth boundary |
| Empty `<emphasis></emphasis>` | **Silent no-op** | Mirrors empty `<say-as>` handling from #232 |
| Nested `<emphasis><say-as characters>ВОЗ</say-as></emphasis>` | **Inner `<say-as>` wins** (Spell takes precedence) | Letter-by-letter spelling already destructures the word; emphasis on a letter sequence is semantically meaningless |
| Mixed `<emphasis>я зн+аю это</emphasis>` (`+` on some words) | **Pass through verbatim** | Vosk processes `+` per-word; words without it use default — natural fit, no extra logic |
| Non-Russian-Vosk voices (Kokoro / AVSpeech) | **Strip `+` + warn-once** | G2P / sidecars don't understand the marker; stripping prevents synth errors |
| Capability flag | **`tts.ru_emphasis_marker`** in `--capabilities-json` features array | Mirrors #232's `tts.ru_acronym_expansion`; lets future TS or Python clients gate on it |
| TS CLI surface | **No new flag** | `<emphasis>` is pure SSML — no analog of `--no-expand-abbrev` needed |

## Architecture

### Pipeline

```
input (SSML text)
    │
    ▼
ssml::parse  →  Vec<Segment>
    Text(String)
    Spell(String)              // <say-as interpret-as="characters">  (#232)
    Break(Duration)
    Ipa(String)                // <phoneme>
    [NEW] Emphasis { content: String, suppress: bool }
                                 ↑                  ↑
                                 inner-text         level=="none"
    │
    ▼
engine-specific normalization:

    ru-vosk-*:    ru::normalize_segments(segments, expand_abbrev)
                    Spell                          → expand_chars(content)
                    Emphasis{c, suppress=false}   → if !c.contains('+'): warn-once "emphasis-no-plus"
                                                     Text(c)         (`+` preserved)
                    Emphasis{c, suppress=true}    → Text(c.replace('+', ""))
                    Text                           → expand_acronyms (if auto_expand)

    en-* / macos-*: kokoro/avspeech segment handler
                    Emphasis{c, _}                 → warn-once "emphasis-non-ru-vosk"
                                                     Text(c.replace('+', ""))
    │
    ▼
synth → WAV
```

### File layout

| Path | Status | Responsibility |
|---|---|---|
| `rust/src/tts/ssml.rs` | MODIFY | Add `Segment::Emphasis { content, suppress }` variant; add `ParsedElement::Emphasis(attrs)` arm before the `other =>` catchall (so `<emphasis>` is no longer warn-stripped). |
| `rust/src/tts/ru/mod.rs` | MODIFY | `normalize_segments` gains an arm for `Emphasis`; honors `suppress` (strip `+`) or honors `+` (pass through, with once-per-process warn if missing). |
| `rust/src/tts/mod.rs` | MODIFY | Kokoro and AVSpeech segment handlers gain `Emphasis` arm: warn-once + strip `+` → feed as Text downstream. |
| `rust/src/capabilities.rs` | MODIFY | Add `"tts.ru_emphasis_marker"` feature string under `#[cfg(feature = "tts")]`. |
| `rust/tests/tts_ru_normalize.rs` | MODIFY | Add a stdin-loop integration test asserting byte-length deltas for the spike-validated `+`-marker behavior + the suppress / level="none" path. |
| `README.md` / `SKILL.md` / `CHANGELOG.md` | MODIFY | User-facing examples + v1.8.0 (unreleased) stub. |

### `Segment::Emphasis` variant

```rust
/// SSML `<emphasis>` content. The Russian-Vosk normalization step honors any
/// `+` markers in `content` (passing them through to Vosk, which interprets
/// `+vowel` as a stress hint per the spike in #233). On non-`ru-vosk-*` voices
/// the `+` markers are stripped before reaching G2P. `suppress` is set when
/// the source tag had `level="none"` — strip `+` markers regardless of voice
/// (SSML composition: a `<emphasis level="none">` overrides an inherited
/// emphasis from an outer scope).
Emphasis {
    content: String,
    suppress: bool,
},
```

### Parser arm (in `ssml.rs::parse`)

Insert BEFORE the `other =>` catchall:

```rust
ParsedElement::Emphasis(attrs) => {
    push_text_slice(&mut segments, &text, cursor, span.start);
    let inner: String = text[span.start..span.end].iter().collect();
    let trimmed = inner.trim();
    if !trimmed.is_empty() {
        let suppress = attrs
            .level
            .as_ref()
            .map(|l| l.eq_ignore_ascii_case("none"))
            .unwrap_or(false);
        segments.push(Segment::Emphasis {
            content: trimmed.to_string(),
            suppress,
        });
    }
    cursor = span.end;
}
```

### Cross-call warning machinery

```rust
// rust/src/tts/ru/mod.rs (or a sibling helper module)
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn warned() -> &'static Mutex<HashSet<&'static str>> {
    static W: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashSet::new()))
}

fn warn_once(key: &'static str, msg: &str) {
    let mut set = warned().lock().expect("warned mutex poisoned");
    if set.insert(key) {
        eprintln!("warning: {msg}");
    }
}
```

This matches the existing `ssml.rs::parse` deduplication pattern (`HashSet<String>` of seen tag names) but lifts the dedup to per-process so warnings don't spam across multiple `tts::say()` calls.

### Routing (Russian Vosk path)

```rust
// rust/src/tts/ru/mod.rs::normalize_segments
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter()
        .map(|s| match s {
            Segment::Spell(t) => Segment::Text(letter_table::expand_chars(&t)),
            Segment::Emphasis { content, suppress } => {
                if suppress {
                    Segment::Text(content.replace('+', ""))
                } else {
                    if !content.contains('+') {
                        warn_once(
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

### Non-Russian-Vosk handling

```rust
// rust/src/tts/mod.rs::synth_segments_kokoro_with — add Emphasis arm:
ssml::Segment::Emphasis { content, .. } => {
    warn_once(
        "emphasis-non-ru-vosk",
        "<emphasis> stress markers are honored only on ru-vosk-* voices; \
         stripping `+` from content for non-Vosk path",
    );
    let stripped = content.replace('+', "");
    let ipa = g2p::text_to_ipa(&stripped, lang)?;
    let audio = sess.infer_ipa(&ipa, voice_path, speed)?;
    out.extend(audio);
}

// synth_segments_vosk_with — also gets the same arm for safety, though
// in practice ru::normalize_segments converts Emphasis → Text upstream.
```

## Capability surface

```jsonc
// kesha-engine --capabilities-json
{
  "features": [
    "transcribe",
    "detect-lang",
    // ... existing entries ...
    "tts",
    "tts.ru_acronym_expansion",  // from #232
    "tts.ru_emphasis_marker"     // NEW
  ]
}
```

No CLI flag. No TS CLI changes. Pure SSML feature.

## Error handling

- `Emphasis` segment with empty `content` → parser does not emit it (silent no-op).
- `Emphasis` reaching Vosk synth → routed through `normalize_segments` to `Text`; if `content` is empty after strip-`+` (e.g., `<emphasis level="none">+</emphasis>`), synth gets empty string — Vosk's existing empty-input handling applies.
- Warn-once machinery lock poisoning → `expect("warned mutex poisoned")` is acceptable since this only fires if a thread panicked while holding the lock — at that point the process is already in an unrecoverable state.

No new error variants. No new failure modes beyond what `<say-as>` introduced in #232.

## Testing

### Unit tests (Rust, inline `#[cfg(test)]`)

`rust/src/tts/ssml.rs::tests`:

```rust
#[test]
fn emphasis_emits_segment() {
    let segs = parse(r#"<speak><emphasis>д+ома</emphasis></speak>"#).unwrap();
    let emphases: Vec<_> = segs.iter().filter_map(|s| match s {
        Segment::Emphasis { content, suppress } => Some((content.as_str(), *suppress)),
        _ => None,
    }).collect();
    assert_eq!(emphases, vec![("д+ома", false)]);
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
fn empty_emphasis_emits_nothing() {
    let segs = parse(r#"<speak><emphasis></emphasis></speak>"#).unwrap();
    assert!(!segs.iter().any(|s| matches!(s, Segment::Emphasis { .. })));
}
```

`rust/src/tts/ru/mod.rs::tests`:

```rust
#[test]
fn emphasis_with_plus_marker_passes_through() {
    let out = normalize_segments(
        vec![Segment::Emphasis { content: "д+ома".into(), suppress: false }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("д+ома".into())]);
}

#[test]
fn emphasis_suppress_strips_plus() {
    let out = normalize_segments(
        vec![Segment::Emphasis { content: "д+ома".into(), suppress: true }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("дома".into())]);
}

#[test]
fn emphasis_without_plus_still_yields_text() {
    let out = normalize_segments(
        vec![Segment::Emphasis { content: "обычное слово".into(), suppress: false }],
        false,
    );
    assert_eq!(out, vec![Segment::Text("обычное слово".into())]);
    // Warning is captured at the warn_once boundary; this test covers data shape only.
}
```

### Integration test (`rust/tests/tts_ru_normalize.rs`)

Use the existing `LoopEngine` (stdin-loop subprocess wrapper, see #232 fixup) to add a new warm-session test:

```rust
#[test]
fn emphasis_marker_shifts_stress() {
    let Some(mut eng) = LoopEngine::spawn() else {
        eprintln!("skipping: vosk-ru models not staged");
        return;
    };

    // baseline: plain "дома" — Vosk default first-syllable stress (ДО́ма)
    let baseline = eng.synth("дома", false, false);

    // дом+а: shift to last-syllable (genitive до-МА́) — spike showed +3KB
    let stressed_last = eng.synth(
        r#"<speak><emphasis>дом+а</emphasis></speak>"#,
        true, false,
    );
    assert!(
        stressed_last.len() > baseline.len() + 2000,
        "дом+а={} baseline={} (expected >+2KB)",
        stressed_last.len(),
        baseline.len(),
    );

    // д+ома: marker agrees with default → no-op (per spike)
    let agrees_with_default = eng.synth(
        r#"<speak><emphasis>д+ома</emphasis></speak>"#,
        true, false,
    );
    let r1 = agrees_with_default.len() as f64 / baseline.len() as f64;
    assert!(
        (0.95..=1.05).contains(&r1),
        "д+ома={} baseline={} ratio={:.2}",
        agrees_with_default.len(),
        baseline.len(),
        r1,
    );

    // level="none" suppresses → matches baseline
    let suppressed = eng.synth(
        r#"<speak><emphasis level="none">дом+а</emphasis></speak>"#,
        true, false,
    );
    let r2 = suppressed.len() as f64 / baseline.len() as f64;
    assert!(
        (0.95..=1.05).contains(&r2),
        "suppressed={} baseline={} ratio={:.2}",
        suppressed.len(),
        baseline.len(),
        r2,
    );
}
```

### Audio-quality-check agent

After commits touching `rust/src/tts/**`, dispatch `audio-quality-check` against a 6-phrase corpus:

- 3 ru-vosk: `дом+а`, `зам+ок`, `пил+и` (positive shifts per spike).
- 1 ru-vosk: `<emphasis level="none">дом+а</emphasis>` (suppress).
- 1 en-am_michael: `<emphasis>hello world</emphasis>` (control: warn-once + strip + Kokoro reads normally).
- 1 ru-vosk: `<emphasis>обычное слово</emphasis>` (no `+` marker, warn-once, content reads with default stress).

Agent reports RMS, silence ratio, sample rate, channels, length-vs-text ratio. Subjective quality — human-in-the-loop spot-check on the same corpus (`afplay`).

## Acceptance criteria

- [ ] `kesha say --voice ru-vosk-m02 --ssml '<speak><emphasis>дом+а</emphasis></speak>'` audibly stresses last syllable (genitive до-МА́); WAV ≥2KB longer than plain `дома`.
- [ ] `kesha say --voice ru-vosk-m02 --ssml '<speak><emphasis level="none">дом+а</emphasis></speak>'` audibly equals plain `дома` within ±5% byte length.
- [ ] `kesha say --voice ru-vosk-m02 --ssml '<speak><emphasis>обычное слово</emphasis></speak>'` synthesizes "обычное слово" with default stress and produces ONE stderr warning per process about the missing `+` marker.
- [ ] `kesha say --voice en-am_michael --ssml '<speak><emphasis>hello+ world</emphasis></speak>'` synthesizes "hello world" (Kokoro reads naturally; the `+` is silently stripped) and produces ONE stderr warning per process about non-Russian-Vosk emphasis.
- [ ] `kesha say --voice ru-vosk-m02 --ssml '<speak><emphasis></emphasis></speak>'` is a silent no-op (empty WAV is acceptable here, OR refuse with the existing "SSML had no speakable content" error).
- [ ] `kesha-engine --capabilities-json` reports `tts.ru_emphasis_marker` in the features array.
- [ ] All Rust unit + integration tests green; `cargo clippy --all-targets -- -D warnings` clean; `cargo fmt --check` clean.
- [ ] `bunx tsc --noEmit` clean (no TS-side changes; sanity check that nothing leaked).
- [ ] `audio-quality-check` agent on the 6-phrase corpus reports no anomalies.
- [ ] README + SKILL.md gain at least one `<emphasis>` example; CHANGELOG.md gets a v1.8.0 (unreleased) stub.

## Verifiability gate (per session standard)

Each implementation task ends with a commit SHA + concrete test output (numbers, not "looks good"). Spec-compliance review re-runs `cargo test / clippy / fmt`. End-to-end evidence captured at `/tmp/kesha-233-evidence/` with `evidence.md` mapping each acceptance criterion to a real `.wav` and a byte count. Audio-quality-check runs on the same evidence directory the user listens to. Final review reads BASE..HEAD diff AND the evidence directory before approval.

## Release path

Engine release (touches `rust/`):

1. Bump `rust/Cargo.toml`, `rust/Cargo.lock` (via `cargo check`), `package.json#keshaEngine.version`, `package.json#version` to **1.8.0** in lockstep on a `release/1.8.0` branch.
2. PR; CI green; merge.
3. `git tag v1.8.0 && git push origin v1.8.0` — triggers `build-engine.yml`.
4. Author release notes BEFORE publishing the draft (per CLAUDE.md "RELEASE PROCESS" gotcha).
5. `gh release edit v1.8.0 --draft=false`.
6. Independent v1.8.0 validation per CLAUDE.md "make smoke-test ALONE DOES NOT VALIDATE A NEW ENGINE": download darwin-arm64 binary, exercise `kesha-engine say --voice ru-vosk-m02 --ssml '<speak><emphasis>дом+а</emphasis></speak>'`, assert WAV ≥50KB AND ≥2KB longer than plain `дома`.
7. `npm publish --access public`.

CLAUDE.md sub-rules that apply:

- `cargo clippy --all-targets -- -D warnings` mandatory.
- ubuntu CI rustc may be newer than local; pull failing-CI logs by ID rather than re-running locally.
- Bun-only user instructions — release notes use `bun add -g`, not `npm i -g`.
- `release/*` branch filter on `integration-tests` job — keeps CI green during the release-PR gap.

## Risks

| Risk | Mitigation |
|---|---|
| Per-process warning noise from long-running daemons (e.g., `--stdin-loop`) — first request without `+` warns, but a hostile or careless client sends thousands of such requests | Warn-once is process-global; daemon writes the warning once per process lifetime, not per request. Acceptable. |
| Vosk-TTS upstream changes the `+`-marker semantics (e.g., starts honoring `+vowel` for default-agreeing positions too) | The spike result is recorded in #233; integration test asserts the directional signal (д+ома still equals baseline). If a future Vosk release changes this, integration test catches the regression. |
| `<emphasis>` content with both `+` markers AND `level="none"` (`<emphasis level="none">д+ома</emphasis>`) — caller is asking us to honor the marker AND also suppress emphasis | Suppress wins (strips `+` from content). Documented in the test matrix. |
| Stress-dictionary integration ever lands (path B from the brainstorm) → API shape conflicts with the current "caller provides `+`" contract | Path B would add a new tag form (`<emphasis dictionary="ruwiki">слово</emphasis>` or similar) without breaking the current caller-provides-`+` contract. Out of scope here. |
| TS-side changes might be needed if a future TS CLI feature gates on `tts.ru_emphasis_marker` | Capability is advertised in `--capabilities-json`. No TS code reads it today; future client work is unblocked. |
