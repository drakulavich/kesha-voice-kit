# Track B Implementation Design — multilingual Kokoro on ONNX (es/fr/it/pt) via CharsiuG2P

- **Date:** 2026-06-01
- **Status:** Design (pre-plan)
- **Tracking issue:** [#212](https://github.com/drakulavich/kesha-voice-kit/issues/212)
- **Predecessor spike:** `docs/superpowers/specs/2026-05-31-onnx-kokoro-multilang-g2p-spike-design.md` (PR #507) — chose Track B (CharsiuG2P + remap + text-normalizer) over espeak-ng (GPL-blocked vs Kesha's MIT). The spike also established that the CoreML es/fr/it/pt voices are the **English** G2P applied to foreign text, so the quality bar here is the **upstream misaki reference**, and this work is an *upgrade* over today's CoreML behavior.

## Goal

Give the ONNX TTS path real per-language G2P for **Spanish, French, Italian, Portuguese**, so `kesha say --voice {es,fr,it,pt}-*` produces natural speech (not English-accented, not digit-collapsed). English (misaki) and the CoreML path are untouched.

### Non-goals
- hi/ja/zh and any non-Latin script (need script-aware G2P; out of scope).
- Castilian Spanish, decimals/currency/dates/ordinals in the normalizer (deferred; v1 is integers + acronyms).
- Changing the CoreML/FluidAudio path or the English misaki path.

## Decisions (from brainstorming, 2026-06-01)

| Decision | Choice | Rationale |
|---|---|---|
| Languages (v1) | es, fr, it, pt | All four; Kokoro-82M speaks them, only G2P was missing. |
| G2P runtime | **CharsiuG2P ByT5 → ONNX → `ort` greedy decode**, spike-gated | Repo-aligned (ort already unconditional, SHA-256-pinnable), generalizes to OOV. Fallback: offline lexicon. |
| Spanish dialect | **Latin-American** (`<spa>`) default | Largest speaker base; spike-validated natural by ear. Castilian deferred. |
| Normalizer | **numbers + acronyms**, per language | The two weaknesses the spike measured; integers + acronym spell-out only (YAGNI). |
| French default voice | `fr-ff_siwis` (**female**) | **Documented exception** to the male-default brand rule: Kokoro v1.0 ships **no male French voice** (only `ff_siwis`). es/it/pt default to male (`em_alex`, `im_nicola`, `pm_alex`). Revisit French when a male voice exists. |

## Architecture

New ONNX-path G2P slotting into the existing `g2p::text_to_ipa` dispatch, with a normalization pass in front. Nothing changes for English or CoreML.

```
rust/src/tts/
├── g2p.rs                 # add es/fr/it/pt branches → charsiu path (currently bails to #212)
├── normalize/             # NEW — runs BEFORE g2p, per language
│   ├── mod.rs             # normalize(text, lang) → text ; dispatch + shared segmenting
│   ├── numbers.rs         # integer → words (es/fr/it/pt)
│   └── acronyms.rs        # per-language letter-name spell-out
├── charsiu/               # NEW — the ONNX G2P engine
│   ├── mod.rs             # to_ipa(text, lang) → IPA via encoder+decoder ort sessions
│   ├── tokenizer.rs       # ByT5 byte-level tokenizer (raw UTF-8 + special ids)
│   ├── decode.rs          # greedy autoregressive decode loop (EOS stop, max-len cap)
│   └── remap.rs           # OOV-symbol → Kokoro-vocab table (ported from spike, tested)
├── tokenizer.rs           # unchanged (IPA → Kokoro token ids)
└── kokoro.rs              # FIX: clamp f32 to [-1,1] before encode; style row = phonemeCount-1
```

**Data flow (ONNX path, non-English):**
`text → normalize(text, lang) → charsiu::to_ipa(·, lang) → remap → tokenizer.encode → kokoro.infer → WAV`

Each unit is independently testable: the normalizer is pure text→text; `charsiu` is text→IPA; `remap` is IPA→IPA; none depend on the others' internals.

## Components

### `charsiu` — ONNX G2P engine
Wraps a pinned ByT5-tiny ONNX export (`encoder.onnx` + `decoder.onnx`) on the existing `ort`.
- `tokenizer.rs`: ByT5 is byte-level — encode = UTF-8 bytes + 3 (offset for special tokens), plus EOS; no sentencepiece. The CharsiuG2P language tag (e.g. `<spa>`, `<fra>`, `<ita>`, `<por-bz>`) is prepended per the model's convention.
- `decode.rs`: greedy autoregressive decode — run encoder once, loop decoder feeding the growing token sequence until EOS or a max-length cap; map output bytes back to the IPA string. A small per-word in-memory cache amortizes repeated tokens within an utterance.
- `mod.rs`: word-segments the normalized text, phonemizes each, joins with spaces.

### `charsiu/remap.rs` — OOV → Kokoro vocab
The spike's table, ported verbatim and **locked by a regression test**: tie-bar affricates `t͡s/t͡ʃ/d͡ʒ` → `ʦ/ʧ/ʤ`; Latin `g` (U+0067) → script `ɡ` (U+0261); pre-composed nasals `õ/ũ/ẽ` → NFD `o/u/e` + combining tilde U+0303. Test asserts **zero residual OOV** against `fixtures/tts/kokoro_vocab.json` for the corpus.

### `normalize/` — text normalization (before G2P)
CharsiuG2P collapses digits and acronyms, so normalize first:
- `numbers.rs`: integer→words per language (`512`→`quinientos doce`, `cinquecento dodici`, …). Romance number-to-words is well-defined. The plan first checks for a license-clean (MIT/Apache) Rust crate covering es/fr/it/pt; if none fits, a compact hand-rolled module (the four Romance systems are regular).
- `acronyms.rs`: per-language letter-name spell-out (`RAI`→`erre a i`), mirroring the English `tts/en/acronym.rs` + `letter_table.rs` Segment approach with es/fr/it/pt letter-name tables.
- `mod.rs`: dispatch by lang; English is unaffected (keeps its existing path).

### `voices.rs` / `models.rs` — routing & distribution
- `voices.rs`: route `es-*`/`fr-*`/`it-*`/`pt-*` on the ONNX path to `charsiu` (today they bail). Defaults: `es-em_alex`, `it-im_nicola`, `pt-pm_alex` (male), `fr-ff_siwis` (female, documented exception — comment in code + PR body, flagged "revisit when a male fr voice exists").
- `models.rs`: pin the CharsiuG2P ONNX files (SHA-256) and the four voice `.bin` packs from onnx-community via the existing `download_verified` mechanism; add to `kesha install --tts`. **No new cargo feature** — this is part of the existing `tts`/`onnx` build, so `build-engine.yml`'s matrix is unaffected (verify with the matrix-vs-defaults diff before any release).

### `kokoro.rs` — two correctness fixes surfaced by the spike
1. **Clamp** synthesized f32 to `[-1, 1]` before WAV encode — Kokoro can emit samples >1.0 (the spike's `fr_0` clipped); locked by the audio-regression "no clipping" check.
2. Style-row index = `min(max(phonemeCount-1, 0), 509)` (the spike render used the padded length; FluidAudio's docs confirm `phonemeCount-1`).

## The spike gate (Plan Phase 0 — mandatory)

Per CLAUDE.md ("verify third-party model formats with a spike"), the ByT5→ONNX export is a named third-party artifact and must be proven before the engine commits to it. Phase 0 spike:
1. Export `charsiu/g2p_multilingual_byT5_tiny_16_layers_100` to ONNX (optimum/transformers).
2. Reproduce the spike's Python IPA from a Rust/`ort` greedy decode on the fixed corpus (es/fr/it/pt).
3. Measure per-utterance latency for interactive `kesha say`.

**Gate:** if export fails, decode-in-`ort` is infeasible, or latency is unacceptable → fall back to the **offline-lexicon** approach (bake `{word:IPA}` per language via CharsiuG2P + a rule-based OOV fallback, the misaki pattern). Record the decision before further work.

## Error handling
- Missing G2P/voice model → the existing loud `kesha install --tts` error (never auto-download).
- Decode produces empty IPA → bail with context (lang, input), mirroring `g2p.rs`'s "empty after G2P" trace; never synthesize silent audio as success.
- Unsupported non-Latin script for these voices → keep the `#492`-style `ScriptUnsupported` guard.

## Testing
- **Unit:** ByT5 byte-tokenizer round-trip; `remap` zero-residual-OOV regression over the spike corpus; numbers/acronyms per language (table-driven); `g2p` dispatch routes es/fr/it/pt to `charsiu`.
- **Audio regression (CI gate):** render the fixed corpus; deterministic checks from the spike (no all-silence, length-vs-grapheme band, **no clipping**). Spike reference WAVs become fixtures.
- **Verification:** `cargo nextest run --features tts` + clippy `--all-targets` + fmt; Greptile + CI gate per repo rules.

## Rollout (PR-able increments)
1. **Phase 0 spike** (feasibility/latency) — decision recorded.
2. `charsiu` engine (tokenizer + decode + remap) behind tests, model pinned.
3. `normalize/` (numbers + acronyms).
4. `voices.rs`/`models.rs` wiring + `kesha install --tts` + the `kokoro.rs` clamp/style fixes.
5. CI audio-regression gate.

**Before the model-pin PR merges:** clarify the CharsiuG2P **weights** license with the author (the code is MIT; the HF weights repo lacks an explicit license — flagged in the spike).

## Risks
- **Autoregressive ONNX decode in `ort`** (KV-cache, EOS, latency) is the primary unknown — Phase 0 spike de-risks it; lexicon fallback if it fails.
- **Number-to-words crate** may not cleanly cover all four languages → hand-rolled fallback (bounded, regular grammars).
- **Weights license** unresolved → blocks the model-pin merge until clarified.
- **French female default** is a brand-rule exception → must be explicitly signed off and documented.
