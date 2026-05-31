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
| G2P runtime | **Pre-converted klebster CharsiuG2P ByT5 ONNX → `ort` KV-cache decode** | Repo-aligned (ort already unconditional, SHA-256-pinnable), generalizes to OOV. Feasibility + byte-identical Rust parity already proven by #185 — no self-export, no spike gate. |
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
Loads the pinned **klebster 3-file ONNX export** (`encoder_model.onnx` + `decoder_model.onnx` + `decoder_with_past_model.onnx`) on the existing `ort`. IO contract per #185 §3.
- `tokenizer.rs`: ByT5 is byte-level — encode = `"<tag>: word"` → UTF-8 bytes + 3 (special-token offset), plus EOS; no sentencepiece. Tags `<spa>`/`<fra>`/`<ita>`/`<por-bz>` (#185 §4).
- `decode.rs`: **KV-cache** autoregressive decode — encoder once; step 0 via `decoder_model` (seeds all `present.*` KV); steps 1..N via `decoder_with_past_model` (re-feed constant encoder KV + updated decoder KV) until EOS or a max-length cap; map output bytes back to IPA.
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

## Feasibility — already established (no spike gate)

CLAUDE.md's "verify third-party model formats with a spike" rule is **already satisfied** by the prior April spike `docs/superpowers/specs/2026-04-22-onnx-g2p-spike.md` (PR #185, on `main`): it downloaded the klebster export, pinned its SHA-256 hashes, documented the full IO contract (§3) + the `ort 2.0` gotchas (§7), and verified **byte-identical Rust↔Python IPA** across 7 scripts (incl. es/fr/it/pt) at ~36 ms/word. So this design pins and loads that published artifact rather than exporting anything. Plan Phase 0 is reduced to *download + hash-verify against the #185 pins*. If those hashes ever stop matching (upstream rehost), that's a deliberate model bump — not a "get it working" override.

## Error handling
- Missing G2P/voice model → the existing loud `kesha install --tts` error (never auto-download).
- Decode produces empty IPA → bail with context (lang, input), mirroring `g2p.rs`'s "empty after G2P" trace; never synthesize silent audio as success.
- Unsupported non-Latin script for these voices → keep the `#492`-style `ScriptUnsupported` guard.

## Testing
- **Unit:** ByT5 byte-tokenizer round-trip; `remap` zero-residual-OOV regression over the spike corpus; numbers/acronyms per language (table-driven); `g2p` dispatch routes es/fr/it/pt to `charsiu`.
- **Audio regression (CI gate):** render the fixed corpus; deterministic checks from the spike (no all-silence, length-vs-grapheme band, **no clipping**). Spike reference WAVs become fixtures.
- **Verification:** `cargo nextest run --features tts` + clippy `--all-targets` + fmt; Greptile + CI gate per repo rules.

## Rollout (PR-able increments)
1. **Phase 0** — download + hash-verify the klebster artifact against the #185 pins (no export).
2. `charsiu` engine (tokenizer + KV-cache decode + remap) behind tests, model pinned.
3. `normalize/` (numbers + acronyms).
4. `voices.rs`/`models.rs` wiring + `kesha install --tts` + the `kokoro.rs` clamp/style fixes.
5. CI audio-regression gate.

**License:** the klebster export is **CC-BY 4.0** (permissive — resolves the earlier "weights license unresolved" concern). Obligation is a `NOTICES` attribution crediting Kleber Noel (ONNX export) + Zhu et al. 2022 (upstream CharsiuG2P), landed with the model-pin PR.

## Risks
- **Autoregressive ONNX decode in `ort`** (KV-cache, EOS, latency) is the primary unknown — Phase 0 spike de-risks it; lexicon fallback if it fails.
- **Number-to-words crate** may not cleanly cover all four languages → hand-rolled fallback (bounded, regular grammars).
- **Weights license** unresolved → blocks the model-pin merge until clarified.
- **French female default** is a brand-rule exception → must be explicitly signed off and documented.
