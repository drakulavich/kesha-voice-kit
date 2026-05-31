# Spike Design — ONNX Kokoro multilingual G2P (es/fr/it/pt-br parity with CoreML)

- **Date:** 2026-05-31
- **Status:** Design (pre-spike)
- **Tracking issue:** [#212](https://github.com/drakulavich/kesha-voice-kit/issues/212)
- **Related history:** [#123](https://github.com/drakulavich/kesha-voice-kit/issues/123) (CharsiuG2P replaced espeak), [#210](https://github.com/drakulavich/kesha-voice-kit/issues/210) (CharsiuG2P IPA mismatch garbled Piper RU), [#213](https://github.com/drakulavich/kesha-voice-kit/issues/213) (espeak-ng + CharsiuG2P both removed, misaki-rs English-only survives), [#124](https://github.com/drakulavich/kesha-voice-kit/issues/124) (espeakng-sys is dynamic-link-only)

## Problem

On the ONNX TTS path, Kokoro synthesizes **English only**. On the CoreML / FluidAudio path it also speaks es/fr/it/pt (+ romanized hi/ja/zh). We want the ONNX path to reach **Latin-5 parity** (en/es/fr/it/pt-br).

### Why ONNX is English-only today (it is G2P, not the model)

Kokoro is a **phoneme-input** model. `rust/src/tts/kokoro.rs` feeds the ONNX session IPA-derived tokens + a style vector + speed; the model has no concept of language, and the embedded vocab (`rust/src/tts/tokenizer.rs`, `fixtures/tts/kokoro_vocab.json`) is the full IPA inventory. **The same Kokoro-82M weights already speak all of the target languages** — verified upstream in #212.

The asymmetry is entirely in the **grapheme→phoneme (G2P) frontend**:

| | ONNX path | CoreML / FluidAudio path |
|---|---|---|
| Who does G2P | Kesha must (`rust/src/tts/g2p.rs` → `misaki-rs`) | FluidAudio does it **internally** (`synthesize_kokoro(text, …)` takes raw text) |
| Languages | English only — `misaki-rs 0.3.0` `Language` enum is just `EnglishUS`/`EnglishGB`; `src/languages/` ships only `english.rs` | en/es/fr/it/pt + hi/ja/zh, **Latin-script input only** (`ensure_script_supported` rejects native Devanagari/kana/Han, #492) |

`g2p.rs` bails for any non-`en*` code, pointing at #212. The multilingual G2Ps that used to exist were removed deliberately: **espeak-ng** (C dep, dynamic-link-only per #124) and **CharsiuG2P** (ONNX ByT5-tiny), both gone by #213.

### The fidelity constraint that makes this non-trivial

Upstream misaki phonemizes es/fr/it/pt **through espeak-ng**, so Kokoro-82M learned **espeak's phoneme convention** for those languages. #210 is the cautionary tale: CharsiuG2P emits a *different* IPA convention, which produced garbled audio for the espeak-trained Piper Russian voice. **Any G2P we pick must emit espeak-compatible IPA, or Kokoro receives effectively-OOV tokens and quality degrades.** This is why the decision must be evidence-gated, not assumed.

## Goal

Decide — **with audio evidence** — which G2P approach gives correct es/fr/it/pt-br pronunciation through the existing ONNX Kokoro tokenizer + session.

### Non-goals

- Production wiring: no changes to `voices.rs`, `say.rs`, install-plan, CLI flags, `models.rs` pins, or CI. Spike code is **throwaway**; only the findings + decision are durable.
- English path (already works via misaki-rs).
- **hi / ja / zh and native-script** input — these need script-aware G2P (pyopenjtalk / jieba+sandhi / indic rules) and are out of scope; even CoreML only does them romanized.
- Performance/latency optimization (model-load caching etc.) — measured but not optimized.

## Approaches under evaluation

### A — Vendored, statically-linked espeak-ng *(fidelity-correct; #212's proposal)*
Bring espeak-ng back as a **static** lib (not the dynamic `espeakng-sys` that hit #124), feed its IPA into the existing Kokoro tokenizer.

- **Pro:** correct by construction — exactly the phonemes Kokoro was trained on; one engine covers all 4 langs and future ones.
- **Con:** static build across macos-14 / ubuntu / windows is real work (~15 MB growth, espeak data files to bundle); reintroduces a C dep the repo philosophically dropped; cross-platform feasibility is the open risk.

### B — CharsiuG2P (ByT5-tiny ONNX) + IPA-remap layer
Pinned multilingual ONNX G2P on the existing `ort` runtime, plus a layer translating its convention into Kokoro's espeak-derived inventory.

- **Pro:** fits every active repo rule (reuses `ort`+`ndarray`, SHA-256-pinnable, no C dep, no dynamic linking); smallest build-system risk.
- **Con:** **this is the #210 failure path** — convention mismatch. The remap layer is the crux and is fragile; quality unproven.

### C — Embedded per-language rule/lexicon G2P *(documented escape hatch)*
Compile-in phonemizers like misaki's English lexicon.

- **Pro:** zero deps, zero download, deterministic, offline; es/it are highly phonetic and work well.
- **Con:** fr/pt hard; drifts from espeak convention (same mismatch risk, self-inflicted); largest sustained effort × 4 langs; upstream misaki-rs has none of this.

## Decision gate

Run **A and B in parallel**, score both, then pick:

1. If **A's static build is feasible on the dev platform with a credible path for ubuntu/windows** AND its audio passes A/B → **A wins** (fidelity-correct).
2. Else if **B's IPA-remap audio passes A/B** → **B wins** (constraint-friendly, but only with audio proof — not blind like #123).
3. Else → escalate to **C** (es/it first) or reopen scope with findings.

Decision matrix (filled by the spike, recorded here + in #212):

| Criterion | Track A (espeak-ng static) | Track B (CharsiuG2P + remap) |
|---|---|---|
| Phoneme match vs upstream misaki | _TBD by spike_ | _TBD by spike_ |
| Audio A/B by ear (per lang) | _TBD_ | _TBD_ |
| audio-quality-check pass | _TBD_ | _TBD_ |
| Static/link or model feasibility | _TBD_ | _TBD_ |
| Cross-platform viability (×3) | _TBD_ | _TBD_ |
| Integration cost into tokenizer | _TBD_ | _TBD_ |

## Shared harness & reference corpus (ground truth, built once)

- **Reference generator:** upstream `kokoro-onnx` (Python) in a **throwaway `/tmp` venv** (per CLAUDE.md — never system-wide), using the **same Kokoro-82M weights** and the matching voices (`em_alex`, `ff_siwis`, `im_nicola`, `pm_alex`). Ground truth because upstream uses misaki→espeak for exactly these languages.
- **Fixed corpus:** 4–6 sentences per language stressing the hard phonetics — Spanish accents/`ñ`, **French nasals + liaison**, Italian geminates, **pt-br nasal vowels `ã/õ`** — plus a shared row with digits, an acronym, and a proper noun. Stored as a small fixture so the run is repeatable.
- **A/B protocol:** for each (lang, sentence, track) render a WAV through the **real Kesha** `tokenizer.rs` + `kokoro.rs` ONNX session, place it beside the upstream WAV, judge by ear.
- **Deterministic gate:** every WAV runs through the **audio-quality-check agent** (RMS, silence ratio, sample rate, channels, length-vs-grapheme ratio) to objectively catch all-silence / wrong-length / clipping — the regression backstop under the subjective A/B.

## Spike tracks (parallel, isolated)

All spike work in a **dedicated worktree** (`.worktrees/kokoro-mlang-g2p-spike/`); downloaded binaries/models in `/tmp/kokoro-mlang-spike/`, deleted after findings are recorded.

### Track A — static espeak-ng feasibility
1. Reproduce the #124 dynamic-link wall, then attempt a **static** path: re-evaluate `espeakng-sys` static feature, `espeak-rs`, and vendoring espeak-ng source via `cc`/CMake.
2. Get IPA for the corpus → feed the **existing** `tokenizer.rs` + `kokoro.rs` → WAV.
3. Prove the build end-to-end on darwin-arm64; **assess** ubuntu/windows static-build viability with a documented path (cross-platform risk is the whole reason A might lose).

### Track B — CharsiuG2P + IPA-remap
1. Download the CharsiuG2P ByT5-tiny ONNX (the #123 model), run via the existing `ort`.
2. Build the **remap layer**: diff CharsiuG2P's symbol set against upstream/espeak phonemes for the corpus, map divergent symbols onto Kokoro vocab entries (the #210 failure point — gets the most scrutiny).
3. Same tokenizer→ONNX→WAV path; A/B + quality-check.

## Deliverables

- Filled decision matrix + a one-paragraph recommendation, committed back to this doc.
- A comment summarizing the finding on issue #212.
- A follow-up **implementation spec** for the winning approach (separate brainstorm → plan cycle). This spike does **not** ship production code.

## Risks

- **A:** static espeak-ng may be infeasible on windows specifically; espeak data-file bundling and binary-size growth fight the repo's lean-binary posture.
- **B:** the IPA-remap may not fully close the convention gap (#210 redux); per-call ONNX G2P latency; a new pinned model in `kesha install --tts`.
- **Corpus:** 5 sentences/language may under-sample edge cases; mitigated by choosing phonetically dense sentences and keeping the fixture extensible.
- **Reference fidelity:** upstream `kokoro-onnx` must use the *same* weights/voices we ship, or the A/B is invalid — pin versions explicitly in the venv.
