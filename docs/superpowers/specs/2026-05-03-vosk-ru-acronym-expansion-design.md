# Russian abbreviation handling for Vosk-TTS

**Date:** 2026-05-03
**Status:** Approved (sections 1-6, brainstormed with maintainer)
**Issue:** #232 (this spec)
**Related:** #233 (tier 3 — stress placement, deferred)
**Branch:** `feat/232-vosk-ru-acronym`

## Problem

Vosk-TTS reads Russian abbreviations as words: ВОЗ → "воз" (one syllable, like the noun *воз*), ФСБ → "фсб" glued, etc. Users expect letter-by-letter spelling: "вэ-о-зэ", "эф-эс-бэ".

The user can wrap such tokens in `<say-as interpret-as="characters">…</say-as>`, but our SSML parser currently treats `<say-as>` (along with `<emphasis>`, `<prosody>`) as known-but-unsupported tags: it warns to stderr and **strips the tag while passing the inner text through unchanged** to the synth (see `rust/src/tts/ssml.rs:239` — "non-goal list for v1"). So SSML hints never reach Vosk.

Vosk-TTS itself does internal text normalization + BERT-prosody + dictionary G2P, but it has no signal that an all-caps token should be spelled.

## Goal

For voice id prefix `ru-vosk-*`:

1. Honor `<say-as interpret-as="characters">…</say-as>` as a deterministic letter-by-letter expansion using a Russian alphabet pronunciation table.
2. Auto-detect Russian acronyms (all-uppercase Cyrillic, length 2–5) in plain text and apply the same expansion. Opt-out via `--no-expand-abbrev`. Stop-list of ~25 ambiguous Russian short words (ОН, МЫ, …) prevents false positives.

Out of scope (this spec):

- Stress placement via `<emphasis>` / `+`-marker → issue #233 (spike confirmed feasibility).
- Latin acronyms in Russian text (NASA, FBI in a Cyrillic sentence).
- Inflected acronyms with lowercase tails (ВОЗа, ФСБшный) — only fully-uppercase tokens match.
- Acronyms with digits or dots (ГОСТ-12345, С.С.С.Р.).
- Numeric `<say-as interpret-as="cardinal|ordinal|date">` — separate concern.
- Other unsupported SSML tags (`<emphasis>`, `<prosody>`, `<phoneme>`, `<sub>`) — continue to warn + strip; #233 covers `<emphasis>`.
- English / Kokoro path — Kokoro has its own G2P.

## Decisions (from brainstorm)

| Question | Decision | Rationale |
|---|---|---|
| Auto-detect default behavior | **On with stop-list** | "Just works" for the common case; stop-list prevents false positives on emphatic uppercase words ("НЕТ! ЭТО МОЁ!") |
| PR scope | **Tier 1 + tier 2 only** | Closes the user's actual complaint (ВОЗ, ФСБ); stress is a separate problem with its own design (#233) |
| Stop-list source | **Hardcoded ~25 words in Rust** | YAGNI: configurable file / frequency dictionary solve problems we don't have yet |
| Token length range | **2–5 Cyrillic uppercase letters** | Covers ИП, РФ, ВОЗ, СНГ, ЦСКА, ВЦСПС; longer tokens are usually misrendered words, not acronyms |
| Trailing punctuation | **Strip, expand, re-attach** | "ВОЗ." → "вэ о зэ." preserves sentence shape |
| Inflected forms (ВОЗа) | **Pass through** (only fully uppercase tokens match) | Predictable; covers the common case |
| Latin in Russian text | **Pass through** (Cyrillic-only matcher) | Out of scope — different G2P story |
| `<say-as>` vs auto-detect interaction | **`<say-as>` wins**, ignores stop-list and case | Explicit user intent overrides heuristics |
| `--no-expand-abbrev` flag | **Disables auto-detect only**, not `<say-as>` | Flag and SSML are different intents |
| Й / Ъ / Ь | Й → "ий"; Ъ, Ь → "" (silent) | Natural-sounding for acronyms; "и краткое" / "твёрдый знак" too verbose |
| Letter-name joiner | **Space** (`"вэ о зэ"`) | Vosk's BERT-prosody behaves better with space-separated tokens than dash-joined |
| capabilities-json flag | **Yes** — `tts.ru_acronym_expansion: true` | TS CLI can probe before forwarding the new flag; avoids breaking against pre-1.6.x engines |

## Architecture

### Pipeline

```
input text  +  optional --ssml flag  +  voice id (ru-vosk-*)
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  1. SSML parse (existing, ssml::parse)                  │
│     "<speak>...</speak>"  →  Vec<Segment>               │
│       • Text(String)                                    │
│       • Break(Duration)                                 │
│       • [NEW] Spell(String) ← from <say-as              │
│            interpret-as="characters">                   │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  2. RU normalization (NEW, tts::ru::normalize_segments) │
│     for each Text segment, if expand_abbrev:            │
│       acronym::expand_acronyms(text)                    │
│     for each Spell segment:                             │
│       letter_table::expand_chars(text)                  │
│     all output collapsed to Segment::Text               │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  3. Vosk synth (existing, tts::vosk::synth_audio)       │
│     concat segments with per-Break silence              │
└─────────────────────────────────────────────────────────┘
    │
    ▼
WAV / OGG-Opus
```

For `en-*` (Kokoro) and `macos-*` voices, step 2 is skipped (input flows directly from step 1 to step 3).

### File layout

```
rust/src/tts/
├── ssml.rs                  ← MODIFIED: add Segment::Spell variant;
│                              <say-as interpret-as="characters"> →
│                              Spell(inner_text). Other interpret-as
│                              values + other unknown tags continue
│                              warn+strip as today.
├── ru/                      ← NEW submodule
│   ├── mod.rs               ← public API:
│   │                          pub fn normalize_segments(
│   │                              segs: Vec<Segment>,
│   │                              auto_expand: bool,
│   │                          ) -> Vec<Segment>
│   ├── acronym.rs           ← acronym detector:
│   │                          pub(super) fn expand_acronyms(&str) -> String
│   │                          fn is_acronym_token(&str) -> bool
│   │                          const STOP_LIST: &[&str] = &[…];
│   │                          #[cfg(test)] mod tests
│   └── letter_table.rs      ← Cyrillic letter-name table:
│                              pub(super) fn expand_chars(&str) -> String
│                              const LETTERS: &[(char, &str)] = &[…];
│                              #[cfg(test)] mod tests
└── mod.rs                   ← MODIFIED: in tts::say(), branch on
                                voice prefix; for ru-vosk-* invoke
                                ru::normalize_segments before synth.
                                Plumb SayOptions { expand_abbrev: bool }.

rust/src/main.rs             ← MODIFIED: --no-expand-abbrev clap arg
                                wired into SayOptions. Add to
                                capabilities-json.

src/cli/say.ts               ← MODIFIED: --no-expand-abbrev passthrough
                                (forward to engine if engine reports
                                capability tts.ru_acronym_expansion).
```

### Public API (Rust)

```rust
// rust/src/tts/ru/mod.rs
pub fn normalize_segments(segs: Vec<Segment>, auto_expand: bool) -> Vec<Segment> {
    segs.into_iter().map(|s| match s {
        Segment::Text(t) if auto_expand => Segment::Text(acronym::expand_acronyms(&t)),
        Segment::Text(t)                => Segment::Text(t),
        Segment::Spell(t)               => Segment::Text(letter_table::expand_chars(&t)),
        other                           => other, // Break, future variants
    }).collect()
}
```

After normalization no `Spell` variants remain — the synth never sees them.

### SSML interaction matrix

| Input | SSML enabled? | `--no-expand-abbrev`? | Result |
|---|---|---|---|
| `ВОЗ объявила` | no | no | `вэ о зэ объявила` (auto-detect on plain text) |
| `ВОЗ объявила` | no | yes | `ВОЗ объявила` (auto-detect off) |
| `ВОЗ` | yes | no | `вэ о зэ` (auto-detect runs on `Segment::Text` content) |
| `<say-as interpret-as="characters">ВОЗ</say-as>` | yes | no | `вэ о зэ` (`<say-as>` wins) |
| `<say-as interpret-as="characters">ОН</say-as>` | yes | no | `о эн` (`<say-as>` overrides stop-list) |
| `<say-as interpret-as="characters">кот</say-as>` | yes | no | `ка о тэ` (`<say-as>` overrides case) |
| `<say-as interpret-as="characters">ВОЗ</say-as>` | yes | yes | `вэ о зэ` (flag does not silence `<say-as>`) |
| `<say-as interpret-as="cardinal">123</say-as>` | yes | * | warn+strip (only `characters` is honored) |

## Expansion rules

### Letter table (`tts::ru::letter_table`)

| Letter | Pronunciation | Letter | Pronunciation | Letter | Pronunciation | Letter | Pronunciation |
|---|---|---|---|---|---|---|---|
| А | "а" | З | "зэ" | П | "пэ" | Ч | "че" |
| Б | "бэ" | И | "и" | Р | "эр" | Ш | "ша" |
| В | "вэ" | Й | "ий" | С | "эс" | Щ | "ща" |
| Г | "гэ" | К | "ка" | Т | "тэ" | Ъ | "" |
| Д | "дэ" | Л | "эль" | У | "у" | Ы | "ы" |
| Е | "е" | М | "эм" | Ф | "эф" | Ь | "" |
| Ё | "ё" | Н | "эн" | Х | "ха" | Э | "э" |
| Ж | "жэ" | О | "о" | Ц | "цэ" | Ю | "ю" |
| | | | | | | Я | "я" |

`expand_chars(input: &str) -> String`:

1. Iterate `input.chars()`.
2. Lowercase each char (`c.to_lowercase()`).
3. Look up in `LETTERS` table. If found, push the pronunciation string. If not found (non-Cyrillic, digit, punctuation), push the char unchanged.
4. Join entries with single space.
5. Collapse double-spaces (e.g. silent Ъ between letters → not a double-space).

Example: `"ЦСКА"` → `"цэ эс ка а"`. Example: `"ОБЪЁМ"` → `"о бэ ё эм"` (silent Ъ).

### Acronym matcher (`tts::ru::acronym`)

`expand_acronyms(input: &str) -> String`:

1. Tokenize on Unicode whitespace boundaries — preserves the original spacing.
2. For each token `t`:
   a. Strip a trailing run of punctuation `[.,:;!?»)„"…—–-]` → `core` + `tail`.
   b. If `core` length is not 2..=5 OR `core` contains anything other than `[А-ЯЁ]` → emit `t` unchanged.
   c. If `core` contains Ъ or Ь → emit `t` unchanged. (Real acronyms do not use these; this rejects emphatic uppercase forms of regular words like ОБЪЁМ, СЪЕЗД, КРЕМЛЬ.)
   d. If `core` ∈ `STOP_LIST` (case-insensitive comparison against the uppercase form already stored) → emit `t` unchanged.
   e. Otherwise emit `letter_table::expand_chars(core) + tail`.
3. Re-join tokens with the same whitespace runs they had.

`is_acronym_token(t: &str) -> bool` is the (b)+(c) check, exposed for test introspection.

### Stop-list (`tts::ru::acronym::STOP_LIST`)

Initial list (alphabetised; uppercase form):
```
ВСЁ, ВЫ, ДА, ДЛЯ, ЕЁ, ЕМУ, ЕЩЁ, ИЛИ, ИМ, ИХ, КАК, КТО, МНЕ, МЫ, НЕ,
НЕТ, НИ, ОН, ОНА, ОНИ, ОНО, ТОТ, ТЫ, УЖ, ЧТО, Я
```

`Я` is length-1 — included for completeness but the length filter (b) above already rejects it before reaching the stop-list. Kept for documentation.

The list is `&[&str]`, comparison is exact `eq` after the input has been verified `[А-ЯЁ]+`. No frequency / corpus lookup. Adding entries is a code change + PR.

## CLI surface

### TS CLI (`src/cli/say.ts`)

New flag:
```
--no-expand-abbrev    Disable Russian acronym auto-expansion for ru-vosk-*
                      voices. <say-as interpret-as="characters"> still works.
                      No effect on en-* (Kokoro) or macos-* voices.
```

Default (flag absent) → auto-expand on.

Forwarded to the engine subprocess only when `getEngineCapabilities().features?.["tts.ru_acronym_expansion"]` is true. On older engines, the flag is silently dropped at the TS layer and a debug log is emitted (mirrors how other capability-gated flags work today, see `rust/src/main.rs` capability checks for `--bitrate`).

### Engine (`rust/src/main.rs`)

```rust
struct SayArgs {
    // ... existing fields ...
    /// Disable auto-expansion of Russian acronyms (ВОЗ → "вэ о зэ").
    /// <say-as interpret-as="characters"> remains honored.
    /// No effect for non-ru-vosk-* voices.
    #[arg(long = "no-expand-abbrev")]
    no_expand_abbrev: bool,
}
```

Plumbed into `tts::say()` as `SayOptions { expand_abbrev: !args.no_expand_abbrev, .. }`.

### `kesha-engine --capabilities-json`

Adds:
```json
{
  "features": {
    "tts.ru_acronym_expansion": true
  }
}
```

The bool is hardcoded `true` for engines that ship this spec; absent in older engines.

## Error handling

- `expand_chars` and `expand_acronyms` are infallible — they return `String`. Non-Cyrillic characters pass through unchanged.
- `Segment::Spell` with empty body → `Segment::Text("")`. Synth handles empty input the same way as today.
- `--no-expand-abbrev` on a non-`ru-vosk-*` voice: silently ignored (the `voice.starts_with("ru-vosk-")` branch in step 2 is the only consumer).
- SSML parse errors (already covered by `ssml::parse`) bubble up unchanged.

No new error variants. No new failure modes.

## Testing

### Unit tests (Rust, inline `#[cfg(test)]`)

`rust/src/tts/ru/letter_table.rs::tests`:
- Full alphabet: every А-Я + Ё → expected letter-name.
- Ъ, Ь → empty string.
- `expand_chars("ВОЗ")` == `"вэ о зэ"`.
- `expand_chars("ЦСКА")` == `"цэ эс ка а"`.
- `expand_chars("ОБЪЁМ")` == `"о бэ ё эм"` (silent Ъ; no double space).
- Non-Cyrillic char in input → pass-through unchanged.
- Empty string → empty string.

`rust/src/tts/ru/acronym.rs::tests`:
- `expand_acronyms("ВОЗ")` == `"вэ о зэ"`.
- `expand_acronyms("ВОЗ.")` == `"вэ о зэ."`.
- `expand_acronyms("ВОЗ объявила")` == `"вэ о зэ объявила"`.
- `expand_acronyms("ОН пришёл")` == `"ОН пришёл"` (stop-list).
- `expand_acronyms("дом")` == `"дом"` (lowercase).
- `expand_acronyms("НасА")` == `"НасА"` (mixed case).
- `expand_acronyms("ВОЗа")` == `"ВОЗа"` (inflected — has lowercase tail).
- `expand_acronyms("NASA")` == `"NASA"` (Latin).
- `expand_acronyms("В")` == `"В"` (length 1).
- `expand_acronyms("АБВГДЕ")` == `"АБВГДЕ"` (length 6).
- `expand_acronyms("ОБЪЁМ")` == `"ОБЪЁМ"` (contains Ъ — rejects emphatic uppercase regular words).
- `expand_acronyms("СЪЕЗД")` == `"СЪЕЗД"` (contains Ъ).
- `expand_acronyms("КРЕМЛЬ")` == `"КРЕМЛЬ"` (length 6 anyway, but also Ь).
- `expand_acronyms("ФСБ и ЦРУ")` == `"эф эс бэ и цэ эр у"`.
- `expand_acronyms("«ВОЗ»")` == `"«вэ о зэ»"` (leading `«` not stripped, trailing `»` is).
- Stop-list extension test: every entry in `STOP_LIST` round-trips unchanged.

`rust/src/tts/ssml.rs` (extend existing):
- `<say-as interpret-as="characters">ВОЗ</say-as>` parses to `Segment::Spell("ВОЗ")`.
- `<say-as interpret-as="cardinal">123</say-as>` continues warn + strip.
- `<say-as>` without `interpret-as` attribute → warn + strip (no `Spell`).

### Integration tests (`rust/tests/tts_ru_normalize.rs`)

End-to-end through `tts::say()` against `voice=ru-vosk-m02`:

- `say("ВОЗ", expand_abbrev=true)` produces audio whose byte-length is at least 2× `say("воз", expand_abbrev=true)` (3 letters → 6 syllables).
- `say("ВОЗ", expand_abbrev=false)` produces audio within ±10% of `say("воз")` (no-op control).
- `say("<speak><say-as interpret-as=\"characters\">ВОЗ</say-as></speak>", ssml=true, expand_abbrev=false)` matches the auto-expand path within ±10% (SSML overrides flag).

Pre-baked ground-truth byte counts captured on first green run; subsequent CI compares with ±10% tolerance.

### Audio-quality-check agent

After every commit touching `rust/src/tts/**`, dispatch the `audio-quality-check` agent with:

- 10 abbreviation phrases (ВОЗ, ФСБ, СНГ, НАТО, США, ЦСКА, ЦБ, МВД, РЖД, ОПЕК).
- 5 stop-list controls (ОН, КОТ, ВЫ, ЕЁ, КАК — none should be expanded).
- 5 plain phrases without acronyms (regression control).

The agent reports RMS, silence ratio, sample rate, channel count, and length-vs-text ratio. Any silent or 10×-off outputs are flagged. Subjective quality is human-checked once during PR review.

## Acceptance criteria

- [ ] `kesha say --voice ru-vosk-m02 'ВОЗ объявила пандемию.'` audibly says "вэ-о-зэ".
- [ ] `kesha say --voice ru-vosk-m02 --no-expand-abbrev 'ВОЗ объявила.'` audibly says "воз" (current behavior).
- [ ] `kesha say --voice ru-vosk-m02 --ssml '<speak><say-as interpret-as="characters">ВОЗ</say-as></speak>'` audibly says "вэ-о-зэ".
- [ ] `kesha say --voice ru-vosk-m02 --ssml '<speak><say-as interpret-as="characters">ОН</say-as></speak>'` audibly says "о-эн" (stop-list bypassed via SSML).
- [ ] `kesha say --voice en-am_michael 'NASA'` unchanged (flag is no-op for non-ru-vosk voices).
- [ ] All Rust unit + integration tests green.
- [ ] `cargo clippy --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --check` clean.
- [ ] Greptile review: no P1 / P2 findings.
- [ ] `kesha-engine --capabilities-json` reports `tts.ru_acronym_expansion: true`.
- [ ] `audio-quality-check` agent on the 20-phrase corpus reports no anomalies.
- [ ] README / SKILL.md / CHANGELOG updated with a Russian-abbreviation example.

## Release path

This is an engine release (touches `rust/`):

1. Bump `rust/Cargo.toml` and `package.json#keshaEngine.version` in lockstep — likely `1.7.0` (new feature, not patch).
2. Bump `package.json#version` to match.
3. Tag → `build-engine.yml` cuts draft release for 3 platforms.
4. Author release notes before publishing (per CLAUDE.md "RELEASE PROCESS").
5. Run independent v\<NEW\> validation per CLAUDE.md "make smoke-test ALONE DOES NOT VALIDATE A NEW ENGINE" before `npm publish`.
6. `npm publish --access public`.

CLAUDE.md sub-rules that apply:
- `clippy --all-targets -- -D warnings` mandatory.
- ubuntu CI rustc may be newer than local; pull failing-CI logs by ID rather than re-running locally.
- model SHA-256 pinning is unaffected (no new model files; only text normalization).
- bun-only user instructions — release notes must say `bun add -g`, not `npm i -g`.

## Risks

- **False positives on emphatic uppercase text.** A user posting "НЕТ! ЭТО МОЁ!" gets "НЕТ" expanded to "эн е тэ". Mitigation: stop-list. Residual risk: words not in stop-list. Detection: integration test on the stop-list controls catches the regression direction; broader false-positive surfaces show up in user reports.
- **Performance.** `expand_acronyms` runs over every `Segment::Text` for ru-vosk-* voices. The matcher is linear over input length with cheap regex-style filtering. Negligible in absolute terms (<1 ms for typical input); not benchmarked in this PR.
- **Stop-list maintenance burden.** Adding entries is a code change + PR. Acceptable for v1; if user reports drive frequent additions, follow up with file-based config (option B from brainstorm Q3).
- **Letter-name choices baked in (e.g., Й = "ий").** Subjective. If multiple users dislike, change is one constant + test re-baseline. Not a structural risk.
