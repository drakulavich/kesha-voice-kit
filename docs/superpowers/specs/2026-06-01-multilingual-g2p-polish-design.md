# Multilingual G2P Polish — Design (#511)

**Status:** approved (brainstorm), pending implementation plan
**Refs:** #511, #212, follow-up to #509

## Problem

#509 shipped multilingual TTS (es/fr/it/pt) on the ONNX Kokoro path via CharsiuG2P plus
a per-language numbers/acronym normalizer. Its review surfaced three non-blocking P3
follow-ups, plus one related number-connector finding. This spec covers all four as a
single cohesive "normalizer + dialect polish" effort.

Three of the four items are **pure deterministic normalizer logic** (no upstream
dependency, exhaustively unit-testable). The fourth — Castilian Spanish — touches G2P
routing and `say` plumbing and is **gated on a spike** of the upstream G2P artifact.

## Goal

- Correct Portuguese number connectors for 4-digit values.
- Correct the French 71 connector ("soixante-et-onze").
- Stop natural word-acronyms (OTAN, OVNI, FIFA, …) from being letter-spelled in es/fr/it/pt.
- Add Castilian Spanish (θ / *distinción*) as a selectable dialect via `--lang es-ES`,
  gated on whether the upstream G2P supports it, with a safe Latin-American fallback.

### Non-goals

- No new voices, no new CLI flags (Castilian reuses the existing `--lang` BCP-47 override).
- No exhaustive acronym dictionaries — curated, extensible seed lists only.
- macOS CoreML (`system_kokoro`) multilingual remains out of scope (closed: #510).
- No change to the English path (`tts/en/*`), which already has its own stop-list.

## Architecture & boundaries

| Component | Files | Nature | Risk |
|---|---|---|---|
| 1. Number connectors | `rust/src/tts/normalize/numbers.rs` | Pure fn | None — deterministic |
| 2. Acronym stop-lists | `rust/src/tts/normalize/acronyms.rs` | Pure fn | None — deterministic |
| 3. Castilian dialect | `rust/src/tts/charsiu/*`, `voices.rs`, `g2p.rs`, `say` plumbing | G2P routing | Spike-gated |
| 4. Wiring/docs/tests | fixtures, runbooks, CLAUDE.md | Glue | None |

Components 1, 2, 4 ship regardless of the spike outcome in Component 3.

## Component 1 — Number connector fixes (`numbers.rs`)

### Portuguese

Replace the unconditional `parts.join(" e ")` in `pt_words` (`numbers.rs:436`) with the
standard rule: insert **"e"** between the thousands group and the remainder **iff** the
remainder is `< 100` **or** an exact multiple of 100; otherwise join with a space.

The existing intra-group connector (hundreds → tens/units, e.g. `cento e vinte e quatro`)
is already correct and stays.

| n | before (wrong) | after (correct) |
|---|---|---|
| 1024 | mil e vinte e quatro | mil e vinte e quatro *(unchanged — was already right)* |
| 1500 | mil e quinhentos | mil e quinhentos *(unchanged)* |
| 1524 | mil **e** quinhentos e vinte e quatro | mil quinhentos e vinte e quatro |
| 2350 | dois mil **e** trezentos e cinquenta | dois mil trezentos e cinquenta |
| 2000 | dois mil | dois mil *(unchanged)* |
| 1100 | mil e cem | mil e cem *(rem 100, round → e)* |

Rule applies only to the thousands↔remainder seam; values ≥ 1,000,000 remain guarded
(return the digit string) as today.

### French

Special-case **71 → "soixante-et-onze"** inside the `70..=79` arm of `fr_under_100`
(`numbers.rs:135`), matching the existing hyphenated `vingt-et-un` style produced by the
`u == 1 && t < 8` branch. 72–79 stay `soixante-douze … soixante-dix-neuf`; 81/91 stay
`quatre-vingt-un` / `quatre-vingt-onze` (no "et") — already correct, covered by a
regression assertion.

## Component 2 — Per-language acronym stop-lists (`acronyms.rs`)

Today `acronyms.rs` letter-spells every all-caps 2–5-char token via the structural
`is_acronym_token` + `spell`. Word-acronyms (read as words, not letters) are spelled
incorrectly.

Mirror the English path (`tts/en/acronym.rs:24`, `STOP_LIST` + the
`every_stop_list_entry_round_trips` test): add `ES_STOP_LIST`, `FR_STOP_LIST`,
`IT_STOP_LIST`, `PT_STOP_LIST` const arrays. The spell path consults the active
language's list case-insensitively; a match passes the token through **unspelled** (no
letter expansion). Unknown languages keep today's behavior.

Seed contents (hand-curated, extensible, explicitly non-exhaustive):

- **es:** OTAN, OVNI, SIDA, OPEP, OEA, ONU, UNESCO, FIFA, OMS
- **fr:** OTAN, OVNI, SIDA, UNESCO, FIFA, OPEP, ONU, OMS
- **it:** FIAT, NATO, FIFA, AIDS, UNESCO, ONU
- **pt:** OTAN, OVNI, SIDA, AIDS, FIFA, UNESCO, ONU, OMS

(Final per-language membership validated by ear during implementation; the list is a
seed, not a contract.)

Initialisms that *should* spell (DNI, ADN, RAI, EUA) are deliberately absent and keep
letter-spelling. No logging.

## Component 3 — Castilian Spanish (spike-gated)

### Selection lever

Reuse the existing `say --lang <LANG>` BCP-47 override (already used for `en-gb`):

- `--lang es-ES` (any `es-ES*` region subtag) → **Castilian** (*distinción*, θ).
- `--lang es`, `es-419`, `es-MX`, `es-AR`, … → **Latin-American** (*seseo*, default).

Thread the BCP-47 region subtag from `--lang` through to the es branch of the G2P path so
it can pick the Castilian tag/behavior. No new voices, no new flags.

### θ background (why a spike is required)

The Castilian θ/s split is 100% predictable from spelling: /θ/ ⇔ every `z` and every `c`
before `e`/`i`; all other /s/ comes from `s`/`x`. But CharsiuG2P output is not aligned to
source graphemes, so a naive post-G2P "/s/→/θ/" remap would wrongly convert /s/ from `s`.
Producing θ correctly therefore needs either a native Castilian G2P tag or careful
grapheme-position tracking — hence the decision gate.

### Phase-1 spike (hard decision gate)

Per the repo's "verify third-party model formats with a spike" rule: download/run klebster
CharsiuG2P end-to-end on a θ-bearing corpus (*zapato, cielo, gracias, zorro, cinco*) and
determine whether it exposes a native Castilian/Iberian Spanish tag (e.g. some `<spa-*>`
variant) that emits θ. Spike artifacts live in `/tmp/castilian-spike/` and are deleted
after the finding is recorded here.

- **Native tag exists →** route `es-ES` to that tag. θ produced natively. Add a regression
  asserting θ appears for *zapato/cielo* and not for *sopa/casa*.
- **No native tag →** **graceful degrade**: `es-ES` still synthesizes, but via the generic
  `<spa>` (LatAm seseo) phonology, and emits a **one-time stderr note**: "Castilian (θ)
  pronunciation is unavailable; using Latin-American Spanish." Castilian θ is deferred to a
  separate later effort (re-open the relevant item). No silent mis-pronunciation, no failure.

stderr-only note keeps stdout pipe-clean per the repo's output contract.

## Component 4 — Wiring, docs, tests

- **Unit tests** (deterministic, in-module):
  - PT connector table (the rows above) + edge cases (1000, 1100, 999_999).
  - FR 71 = "soixante-et-onze"; 72/79/81/91 control assertions.
  - Stop-lists: every seed entry round-trips unspelled per language; a control initialism
    (DNI/RAI) still spells; cross-language isolation (an es entry doesn't suppress spelling
    under `it`).
- **Audio regression:** add to `rust/fixtures/tts/multilang_corpus.json` a PT 4-digit
  sentence, a FR-71 sentence, and an `es-ES` θ sentence; run the audio-quality-check agent
  (no-clip / 24 kHz / RMS / length) as the pre-merge gate.
- **Docs:** CLAUDE.md TTS section and `docs/runbooks/tts-internals.md` document the
  `es-ES` lever and the degrade behavior; note the stop-lists are seed lists.

## Error handling

- Components 1 & 2 are pure functions over already-validated input; no new failure modes.
- Component 3 never hard-fails on dialect: unknown/unsupported region degrades to LatAm
  with a stderr note. Missing models still fail loudly with the existing
  `kesha install --tts` hint (unchanged).

## Testing strategy

- Deterministic logic: exhaustive small-case unit tests (fast, no models).
- Castilian: spike validates the upstream contract before any routing code commits to it;
  end-to-end audio regression validates the chosen path.
- Full Rust gate per CLAUDE.md: `cargo fmt && cargo clippy --all-targets -- -D warnings &&
  cargo nextest run --features tts`.

## Rollout / linkage

Single PR, `Refs #212`, `Closes #511`. The PR body records the spike finding (native tag
vs degrade). If Castilian degrades, note in the PR that θ is deferred.
