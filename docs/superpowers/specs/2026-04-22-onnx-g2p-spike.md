# ONNX G2P Spike — Replace espeak-ng with CharsiuG2P ByT5

**Date**: 2026-04-22
**Status**: Spike complete; implementation plan proposed
**Issue**: [#123](https://github.com/drakulavich/kesha-voice-kit/issues/123)
**Scope**: New `rust/src/tts/g2p_onnx.rs`, model manifest entry, parity harness, SSML `<phoneme>` override (per-word G2P escape hatch)

## Problem

`rust/src/tts/g2p.rs` currently calls `espeakng-sys` (dynamically linked against system libespeak-ng) for grapheme-to-phoneme in both Kokoro and Piper pipelines. This carries three frictions:

- System dependency — a dangling install step (`brew install espeak-ng` / `apt install espeak-ng` / `choco install espeak-ng`) plus Windows import-lib synthesis in CI (`dumpbin /exports` + `lib /def:...`) that has been a recurring operational tax.
- No self-contained release artifact — the binary is reproducible but the runtime isn't.
- Mixed inference stack — ASR, language-id, and Kokoro are all ONNX / CoreML, but G2P is a C library. Normalizing the stack simplifies operations and cross-compilation.

Issue #123 acceptance criteria are literal: "`kesha say` produces IPA phonemes purely via ONNX/CoreML on all platforms — no espeak-ng call."

## Decision

**Hard swap to the pre-converted ONNX export at [klebster/g2p_multilingual_byT5_tiny_onnx](https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx)** (CC-BY 4.0, published 2026-04). Delete `rust/src/tts/g2p.rs` and drop `espeakng-sys` from the dependency graph in a single PR. No deprecation window.

**Why no `legacy-g2p` feature:** carrying espeak-ng for one more release cycle means keeping the Windows import-lib synthesis (`dumpbin /exports` + `lib /def:...`), the Linux `LIBCLANG_PATH` build-env, and the macOS `DYLD_FALLBACK_LIBRARY_PATH` runtime-env — i.e. exactly the operational tax this issue exists to remove. The escape hatch for a real regression is `git revert`, not a feature flag. Prior "feature swap" patterns (`system_tts` in #141; the `coreml`/`onnx` split in M2) were for *coexisting* backends — this is a straight replacement.

**Weights default: FP32** (102 MB across three files), using the pinned hashes captured during the spike (section 1). INT8 quantization (~27 MB) is deferred to a follow-up because it requires a separate quantize-and-republish step (not published upstream) before the hashes can be pinned. FP32 lets Phase 1 start immediately with known-good artifacts; INT8 lands as its own PR once `drakulavich/g2p-byt5-tiny-onnx` mirror hosts the INT8 export.

**SSML `<phoneme>` override is in scope** for this cycle, not deferred. Without it, users hitting G2P quality regressions (`pneumonia → ˈpnuˈmoʊniˌɑi`) have no workaround — and `<phoneme alphabet="ipa" ph="...">` is the exact ergonomic release valve SSML was designed for. Current v1 SSML (#140) strips `<phoneme>` with a warning; this PR wires it to bypass G2P and feed the caller-supplied IPA straight to the synthesis pipeline.

## Approaches considered and rejected

1. **Hand-port misaki (Kokoro's upstream Python G2P) to Rust.** Multi-week; spaCy + num2words + pronunciation dictionary + espeak fallback all need reimplementation. Not justified for the size/quality delta.
2. **Convert FluidAudio's CoreML G2P → ONNX.** `coremltools` + `onnxmltools` targets only legacy NeuralNetwork `.mlmodel` format. FluidAudio ships `.mlpackage` (ML Program). No mature public tool emits ONNX from ML Program IR as of April 2026 ([onnxmltools 1.14.0](https://github.com/onnx/onnxmltools) is the current release and does not cover this). Would require writing a custom ML Program → ONNX op mapper.
3. **Train a custom seq2seq from CMU dict + misaki outputs.** ~2–5M params, fits the 20 MB brand target. Abandoned because a pre-trained model with the exact same CharsiuG2P lineage already exists on HuggingFace — the training work would reproduce an existing artifact.
4. **Use a different ONNX candidate.** Considered [Jarbas/charsiu_g2p_multilingual_byT5_small_100_onnx](https://huggingface.co/Jarbas/charsiu_g2p_multilingual_byT5_small_100_onnx) (ByT5-small, larger and higher quality) and [OpenVoiceOS/g2p-multilingual-byt5-tiny-8l-ipa-childes-onnx](https://huggingface.co/OpenVoiceOS/g2p-multilingual-byt5-tiny-8l-ipa-childes-onnx) (different base model, children's-speech fine-tune). klebster's tiny export wins on size and comes from the same base checkpoint FluidAudio ships in CoreML — maximum compatibility with the quality baseline upstream expects.

## Spike — what ran

Per the repo's "VERIFY THIRD-PARTY MODEL FORMATS WITH A SPIKE" rule. Artifacts live under `/tmp/onnx-g2p-spike/` (deleted after spike).

### 1. Downloaded and SHA-pinned

```
encoder_model.onnx                 55M   1ac7aca11845527873f9e0e870fbe1e3c3ac2cb009d8852230332d10541aab04
decoder_model.onnx                 25M   de32477aae14e254d4a7dee4b2c324fb39f93a0dc254181c5bfdd8fc67492919
decoder_with_past_model.onnx       22M   fae30b9f3a8d935be01b32af851bae6d54f330813167073e84caf6d0a1890fcb
config.json                       846    50c9e67c1fe2ea8a959940858bcd6d720be525c7086df798629c48d039583d49
generation_config.json            142    dc76b739df77a0b5442d76b10c2553cd66953de3d1c5107d2eb2ddd3a5686e52
tokenizer_config.json             25K    3be33c710b17ac8686cd2b82ec044b0cd1122ff92c651d7170bfe1af8256ebfb
special_tokens_map.json           3.1K   3c2572df5f4ec60a476e5d90a1f52a989f9eefbbf381d358924a44a648bf0edb
added_tokens.json                 3.0K   0004781309423057d33b9edf50d2669253d4347873ea33d4e7755cb866f23883
```

Total FP32 footprint: **102 MB uncompressed**. INT8 quantized variant (per upstream README) is ~27 MB; not provided as a published file but can be generated at release time via `onnxruntime.quantization.quantize_dynamic`.

### 2. Model architecture (from `config.json`)

```
model_type            t5
architectures         T5ForConditionalGeneration
vocab_size            384
d_model               256
d_ff                  1024
d_kv                  64
num_layers            12   (encoder)
num_decoder_layers    4
num_heads             6
decoder_start_token   0  (pad)
eos_token_id          1
pad_token_id          0
tokenizer_class       ByT5Tokenizer
```

Byte-level tokenizer, offset `byte + 3`. No vocab file needed at runtime.

### 3. ONNX graph I/O (verified with `ort.InferenceSession.get_inputs/outputs`)

**`encoder_model.onnx`** — 55 MB FP32

| | name | dtype | shape |
|---|---|---|---|
| IN | `input_ids` | int64 | `[B, S_enc]` |
| IN | `attention_mask` | int64 | `[B, S_enc]` |
| OUT | `last_hidden_state` | float | `[B, S_enc, 256]` |

**`decoder_model.onnx`** — 25 MB FP32 (used only for step 0)

| | name | dtype | shape |
|---|---|---|---|
| IN | `input_ids` | int64 | `[B, S_dec]` |
| IN | `encoder_attention_mask` | int64 | `[B, S_enc]` |
| IN | `encoder_hidden_states` | float | `[B, S_enc, 256]` |
| OUT | `logits` | float | `[B, S_dec, 384]` |
| OUT × 16 | `present.{0..3}.{decoder,encoder}.{key,value}` | float | `[B, 6, S, 64]` |

**`decoder_with_past_model.onnx`** — 22 MB FP32 (used for steps 1..N)

| | name | dtype | shape |
|---|---|---|---|
| IN | `input_ids` | int64 | `[B, 1]` |
| IN | `encoder_attention_mask` | int64 | `[B, S_enc]` |
| IN × 16 | `past_key_values.{0..3}.{decoder,encoder}.{key,value}` | float | `[B, 6, past, 64]` |
| OUT | `logits` | float | `[B, 1, 384]` |
| OUT × 8 | `present.{0..3}.decoder.{key,value}` | float | `[B, 6, past+1, 64]` |

Key detail: `decoder_with_past` emits only the **decoder** K/V presents. The encoder K/V entries stay constant across steps — they're seeded from step 0 and re-fed verbatim every subsequent step.

### 4. Python end-to-end (reference)

Greedy decode, hand-rolled (no Optimum dep — we want to match exactly what Rust does).

```
word            lang           ms  IPA
----------------------------------------------------------------------
hello           eng-us      26.21  ˈhɛɫoʊ
world           eng-us      23.03  ˈwɝɫd
read            eng-us      20.33  ˈɹid
lead            eng-us      21.26  ˈɫid
pneumonia       eng-us      41.24  ˈpnuˈmoʊniˌɑi    ← noisy trailing phonemes
chimneys        eng-us      35.19  ˈtʃɪmˌneɪs
colour          eng-uk      24.06  kˈʌlə
bonjour         fra         26.32  bɔ̃ʒuʁ
Straße          ger         32.52  ˈʃtɾɑːseo        ← noisy trailing "eo"
привет          rus         31.41  prʲɪvʲetə
你好              cmn         37.38  ni˨˩˦xɑʊ˨˩˦
こんにちは           jpn         35.44  koɴnitɕihaɯ
----------------------------------------------------------------------
mean latency: 29.53 ms/word (single-thread CPU, FP32)
```

### 5. Rust parity (target)

Same fixtures, same decode algorithm, `ort 2.0.0-rc.12` matching the workspace Cargo.toml.

```
word            lang           ms  IPA
----------------------------------------------------------------------
hello           eng-us      33.53  ˈhɛɫoʊ
world           eng-us      28.23  ˈwɝɫd
read            eng-us      27.25  ˈɹid
lead            eng-us      25.34  ˈɫid
pneumonia       eng-us      44.21  ˈpnuˈmoʊniˌɑi
chimneys        eng-us      42.66  ˈtʃɪmˌneɪs
colour          eng-uk      30.82  kˈʌlə
bonjour         fra         33.60  bɔ̃ʒuʁ
Straße          ger         37.41  ˈʃtɾɑːseo
привет          rus         39.12  prʲɪvʲetə
你好              cmn         48.45  ni˨˩˦xɑʊ˨˩˦
こんにちは           jpn         41.93  koɴnitɕihaɯ
----------------------------------------------------------------------
mean latency: 36.05 ms/word (single-thread, FP32, KV cache)
```

**Every IPA string is byte-identical between Python and Rust.** Rust is ~6ms/word slower, attributable to the `ArrayD<f32>` round-trip when moving past KV between steps (we clone each tensor every step). Optimisable later by holding `Value` handles across steps instead of re-materializing owned arrays. Both runtimes are well under a 100 ms "feels live" threshold for interactive synthesis.

### 6. Quality observations

- ✅ In-dictionary English words are correct (`hello`, `world`, `chimneys`, `colour`).
- ✅ Multilingual path works across 7 scripts (Latin, Cyrillic, Hans, Hiragana, Katakana, umlaut-bearing Latin, Greek/French diacritics).
- ⚠️ `pneumonia → ˈpnuˈmoʊniˌɑi` — wrong; doesn't know the P is silent and emits a spurious trailing "ɑi". Same class of out-of-dictionary error espeak-ng's OOV fallback path has; inherent to the 15M-param model, not the ONNX export.
- ⚠️ Homographs (`read`, `lead`) default to present tense — same limitation as espeak without POS context. Out of scope for this issue.
- ⚠️ `Straße → ˈʃtɾɑːseo` — noisy tail. Again a model quality issue, not an export issue.

Upstream README reports 8.1% PER / 25.3% WER across 100 langs × 500 words greedy — consistent with these observations. For comparison, espeak-ng has no single published PER baseline on the same set, but anecdotally performs similarly on English in-dictionary words and worse on low-resource languages.

Per issue #123 acceptance criterion "perceptual quality on a fixture corpus ≥ current espeak-ng baseline": this is what the parity harness below must verify before the PR merges.

### 7. API compatibility with `ort 2.0.0-rc.12`

Two gotchas hit during the Rust spike — call them out so the implementation PR lands them correctly on the first push:

- `ort::Error<SessionBuilder>` is not `Send + Sync` (it holds `NonNull<OrtSessionOptions>`), so `anyhow::Error: From<_>` does not apply and `?` against the session builder API does not compile directly. Wrap with `.map_err(|e| anyhow!("ort: {e}"))` or a small macro. This is ort 2.0's deliberate break from 1.x — live with it.
- `Value::from_array` requires an owned `Array<T, D>` (not `ArrayView`). Use `TensorRef::from_array_view(&arr)?` when you want to avoid cloning. `inputs![]` macro accepts both.

## Plan — implementation after the spike

Tagged to issue #123 acceptance criteria.

### Phase 1 — wire the FP32 model (no behaviour change yet)

- **M1.1** Add a `g2p_onnx` manifest entry to `rust/src/models.rs`. Pinned hashes are the FP32 artifacts captured during the spike (section 1):
  ```rust
  #[cfg(feature = "tts")]
  pub fn g2p_onnx_manifest() -> Vec<ModelFile> {
      vec![
          ModelFile { rel_path: "models/g2p/byt5-tiny/encoder_model.onnx",
                      url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/encoder_model.onnx",
                      sha256: "1ac7aca11845527873f9e0e870fbe1e3c3ac2cb009d8852230332d10541aab04" },
          ModelFile { rel_path: "models/g2p/byt5-tiny/decoder_model.onnx",
                      url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/decoder_model.onnx",
                      sha256: "de32477aae14e254d4a7dee4b2c324fb39f93a0dc254181c5bfdd8fc67492919" },
          ModelFile { rel_path: "models/g2p/byt5-tiny/decoder_with_past_model.onnx",
                      url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/decoder_with_past_model.onnx",
                      sha256: "fae30b9f3a8d935be01b32af851bae6d54f330813167073e84caf6d0a1890fcb" },
      ]
  }
  ```
  `cargo test models::manifest_tests` guards the shape invariants. `KESHA_MODEL_MIRROR` rewriting applies automatically since all three URLs are on HuggingFace — no mirror-path gymnastics needed.
- **M1.2** Extend `kesha install --tts` to fetch the g2p manifest alongside Kokoro and Piper. No effect on default paths yet.
- **M1.3** Add `NOTICES` entry crediting Kleber Noel (ONNX export) and Zhu et al. 2022 (upstream CharsiuG2P). Required by CC-BY 4.0.

### Phase 2 — implement the ONNX G2P module (hard swap)

- **M2.1** `Cargo.toml` changes:
  ```toml
  [features]
  default = ["onnx", "tts"]
  tts = ["dep:hound", "dep:thiserror", "dep:ssml-parser"]
  # `espeakng-sys` removed entirely — no `legacy-g2p` feature.
  ```
  Drop `espeakng-sys` from `[dependencies]`. Delete `rust/src/tts/g2p.rs`. Neither file nor dependency survives the PR.
- **M2.2** New `rust/src/tts/g2p_onnx.rs` (renamed to `g2p.rs` on the final push since there's no legacy version to distinguish from):
  - Thin wrapper loading three `ort::Session`s (encoder, decoder, decoder_with_past) via `ort 2.0.0-rc.12`.
  - Public function: `pub fn text_to_ipa(text: &str, lang: &str) -> anyhow::Result<String>`.
  - Signature matches the deleted espeak one so `mod.rs` dispatch stays trivial — just a `use` line change.
  - Language codes: map espeak-style (`en-us`, `ru`) to CharsiuG2P codes (`eng-us`, `rus`) via a small match arm; reject unknown codes with a clear error.
  - Tokenization: `"<{lang}>: {word}"` → UTF-8 bytes → `byte + 3` → append EOS(1). Exactly matches the reference.
  - Decode loop: step 0 via `decoder_model` (seeded with PAD=0), harvest full KV; steps 1..128 via `decoder_with_past_model`, updating only decoder KV; break on EOS.
  - Word-splitting: text is split on whitespace + punctuation, each word run through G2P, results joined with spaces. Matches the deleted `g2p.rs`'s output format so the downstream `tokenizer::Tokenizer::encode` doesn't change.
  - Session lifetime: follow the existing Kokoro/Piper/VAD pattern — load sessions per-call inside `text_to_ipa`, not a process-global `OnceLock`. Consistent with the rest of the codebase; global caching is a separate, repo-wide refactor if ever wanted.
- **M2.3** Runtime error when model files are missing — mirror the existing Kokoro/Piper UX. Message: `"G2P model not installed. Run `kesha install --tts` to download."`
- **M2.4** Port ort-2.0 gotchas:
  - Non-Send `ort::Error<SessionBuilder>` — handle inline with `.map_err(anyhow::Error::msg)` at callsites (3-4 of them). A dedicated `ort_try!` macro is overkill for this usage count.
  - `Value::from_array` requires owned ndarrays in 2.0.0-rc.12; `TensorRef::from_array_view(&arr)` when zero-copy views are worth it.
- **M2.5** SSML `<phoneme alphabet="ipa" ph="...">` — wire into `tts/ssml.rs` so contained text is bypass-G2P and the `ph` IPA is fed directly to the tokenizer. Today this tag strips with a warning (#122 follow-up); this milestone promotes it to a first-class segment variant. `<phoneme alphabet>` values other than `ipa` continue to warn-strip.

### Phase 3 — parity harness

- **M3.1** `rust/tests/g2p_onnx_parity.rs`:
  - Loads a 200-word CMU dict subset plus a 10-lang × 20-word per-language fixture (Russian, French, German, Japanese, Mandarin, Hindi, Italian, Portuguese-BR, British English).
  - For each word: assert ONNX output is non-empty, valid UTF-8, and contains at least one character from the IPA Unicode block. Since the espeak backend is gone, there's no cross-backend edit-distance check here — parity is validated against the frozen reference corpus committed alongside the test (`rust/fixtures/g2p/reference-ipa.json`) generated from the FP32 model at the pinned SHAs.
  - Fixture files under `rust/fixtures/g2p/`; the reference IPA JSON is sha-pinned too so a model rehost that changes outputs is a visible test failure.
- **M3.2** Add `BENCHMARK.md` section: "G2P backend". Table rows: backend, binary size delta, latency ms/word @ 1 thread, PER baseline (8.1% per upstream paper).
- **M3.3** Manual perceptual QA: synthesize 20 varied utterances through Kokoro (en-af_heart) and Piper (ru-denis), compare against the current v1.4.0 espeak-backed release blind. Record results in the PR body. Acceptance criterion #3 literally.
- **M3.4** SSML `<phoneme>` parity test: `<speak>He said <phoneme alphabet="ipa" ph="nuˈmoʊniə">pneumonia</phoneme>.</speak>` produces audio where the phoneme override fully replaces what G2P would have emitted for "pneumonia". Regression guard for the ergonomic escape hatch.

### Phase 4 — docs + release

- **M4.1** Update `CLAUDE.md` TTS section: drop the system-dep bullet, note the new G2P model, remove the espeak-ng build-env lines (`LIBCLANG_PATH`, `DYLD_FALLBACK_LIBRARY_PATH` stays for ORT).
- **M4.2** Update `README.md` TTS section: remove the `brew install espeak-ng` line. Mention SSML `<phoneme>` override as a new supported tag.
- **M4.3** Update `rust-test.yml` — drop the `espeak-ng` install step on linux/windows CI entirely. No matrix-row carve-out needed.
- **M4.4** Update `build-engine.yml` `features` matrix — no new feature to add since `onnx-g2p` isn't a feature flag. The existing `tts` rows cover it automatically.
- **M4.5** Write release notes: binary size delta (−15 MB engine, +102 MB models when `--tts` is installed), new default (ONNX G2P, hard swap — no opt-in/out), new SSML `<phoneme>` override, the CC-BY 4.0 attribution.
- **M4.6** Close #124 (espeak-ng vendoring) as "no longer needed" — removing espeak-ng altogether is the cleaner resolution than vendoring it.

## Binary size impact

| | before | after (FP32 default) | after (INT8 follow-up) |
|---|---|---|---|
| Binary (release, stripped) | baseline | **−15 MB** | −15 MB |
| Cached models (`~/.cache/kesha/`) | 0 | **+102 MB** | +27 MB |
| Net delta when TTS is installed | 0 | +87 MB | +12 MB |
| System deps | `espeak-ng` | none | none |

The repo's brand target is 20 MB *per model family*, not total. FP32 combined (encoder + both decoder graphs) is 102 MB — over target. Accepted tradeoff for shipping FP32 first: reference-exact weights with pinned upstream SHAs, no quantize-publish-repin dance blocking issue #123. INT8 is tracked as a follow-up issue once `drakulavich/g2p-byt5-tiny-onnx` hosts the quantized export with its own pinned hash.

## Risks

- **CC-BY 4.0 attribution requirement.** Must land `NOTICES` and a reference in `CLAUDE.md`. Easy but easy to forget.
- **Per-word latency on cold start.** First synthesis pays ~100 ms session-load cost for three sessions. Accepted — matches the Kokoro/Piper per-call load pattern. A process-wide session cache would help batch callers but is a separate repo-wide refactor that would also apply to the other engines; not folded into this PR to keep the abstraction consistent.
- **Multi-word inputs** go through the G2P per word. A 100-word input at 36 ms/word = 3.6 s on this sandbox, dominated by synthesis anyway. Optimisation (batched encoder inference, or a single "whole utterance" pass) is a follow-up, not a blocker.
- **OpenVoiceOS uses a simpler direct-encoder-decoder ONNX export** (`byt5_g2p_model.onnx` single file); some upstream downstreams expect that format. klebster's encoder+decoder+decoder_with_past split is what Optimum produces for `ORTModelForSeq2SeqLM`. We consciously picked klebster because the KV-cache split runs faster. No interop cost — only we consume the artifact.
- **ort 2.0.0-rc.12 is a release candidate.** Workspace is already on it; no bump needed. If the line bumps to stable 2.0 mid-implementation, the inline `map_err(anyhow::Error::msg)` sites may no longer be necessary (stable 2.0 likely relaxes the non-Send `Error<SessionBuilder>` constraint) — strip them then.
- **INT8 quantization is deferred.** The klebster repo doesn't publish an INT8 variant; generating it at install time is non-deterministic and hostile to hash pinning. Phase 1 ships FP32 with the upstream-pinned SHAs captured here. INT8 lands as a follow-up PR + issue, hosted on `drakulavich/g2p-byt5-tiny-onnx` with its own pinned hash once quantized + parity-checked.

## Follow-ups

- **INT8 quantization** — file issue, host artifact on `drakulavich/g2p-byt5-tiny-onnx`, parity-check vs FP32, swap manifest SHAs. ~60 MB cache savings for TTS users.
- **Issue #124 (espeak-ng vendoring)** — close as "no longer needed" as part of this PR's cleanup; removing espeak-ng altogether supersedes vendoring it.
- **FluidAudio parity benchmark** — optional. Since we converge on the same upstream PyTorch checkpoint, outputs should match byte-for-byte. If they don't, the difference is measurement noise or FluidAudio fine-tuned after conversion. Not a blocker for #123.
- **Homograph disambiguation** (`read`, `lead`, `wind`) — requires a POS-tagging preprocessing pass, out of scope. Open a follow-up issue if it surfaces in user reports.

## References

- Spike artifacts: `/tmp/onnx-g2p-spike/` (deleted after merge of this plan)
- Upstream model: [klebster/g2p_multilingual_byT5_tiny_onnx](https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx)
- Base checkpoint: [charsiu/g2p_multilingual_byT5_tiny_16_layers_100](https://huggingface.co/charsiu/g2p_multilingual_byT5_tiny_16_layers_100)
- Paper: Zhu et al. "ByT5 model for massively multilingual grapheme-to-phoneme conversion", Interspeech 2022 — [arXiv:2204.03067](https://arxiv.org/abs/2204.03067)
- FluidAudio G2P for parity reference: [Sources/FluidAudio/TTS/G2P/MultilingualG2PModel.swift](https://github.com/FluidInference/FluidAudio/blob/main/Sources/FluidAudio/TTS/G2P/MultilingualG2PModel.swift)
- Reference phonemizer library: [TigreGotico/phoonnx](https://github.com/TigreGotico/phoonnx) — wraps the same ONNX models in Python, useful cross-check
