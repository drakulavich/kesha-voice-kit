# Replace Piper with vosk-tts for Russian TTS

**Date:** 2026-04-27
**Status:** Approved (sections 1-5)
**Refs:** #207, #210, #212; PR-in-progress: branch `fix/piper-ru-espeak-passthrough` (will rename to `fix/replace-piper-with-vosk-ru`)

## Problem

Piper Russian (`ru_RU-ruslan-medium`) is the current `ru` engine after PR #210 added `espeak-ng` subprocess G2P with punctuation passthrough. Even after that fix, the user evaluated the audio side-by-side with Vosk's HF-hosted samples and Vosk's M02 male voice was clearly preferred. The pre-rendered Vosk samples cover prosody and naturalness Piper can't match at the same model size.

Piper also forced us to introduce `espeak-ng` as a system dependency (`brew install espeak-ng` / `apt install espeak-ng` / Windows chocolatey + dynamic-link concerns from #124). That re-broke the kesha brand promise of "no system deps". Switching to Vosk lets us drop that dependency.

## Goal

Replace the Russian Piper path with `vosk-tts-rs` (Rust crate, ONNX Runtime, Apache 2.0). Use the upstream multi-speaker model `vosk-model-tts-ru-0.9-multi` mirrored on HuggingFace at `drakulavich/vosk-tts-ru-0.9-multi`. Default Russian voice on Linux/Windows becomes `ru-vosk-m02` (male, matches CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE"). darwin keeps `Milena` (AVSpeech) as a zero-install convenience.

Out of scope: voice cloning, multilingual Kokoro (#212), Kokoro upstream G2P replacement (#208), INT8 quantization of vosk model.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Replace Piper-ru with Vosk? | **Yes, fully** | Vosk M02 sounds better than Piper Ruslan; one less engine to maintain; no espeak system dep |
| Keep Piper engine for other languages? | **No, delete the engine entirely** | No remaining users; can be restored from git if a future language needs it |
| Keep CharsiuG2P fallback? | **No, drop it** | No callers after Russian moves off it; saves ~100 MB from `kesha install --tts` |
| Keep `espeak-ng` subprocess (`g2p_espeak.rs`)? | **No, delete it** | Vosk handles its own G2P (BERT-based prosody + Russian rule-based stress/palatalization); espeak no longer needed |
| Default RU voice on darwin | `macos-com.apple.voice.compact.ru-RU.Milena` (Milena, AVSpeech) | Zero install, sensible default-of-default; `--voice ru-vosk-m02` opt-in for higher quality |
| Default RU voice on Linux/Windows | `ru-vosk-m02` | Per CLAUDE.md male-voice rule; replaces `ru-ruslan` |
| Model source | `drakulavich/vosk-tts-ru-0.9-multi` (HF mirror) | CDN reliability; matches our pinning pattern. alphacephei.com 0.9 zip mirrored to HF |
| Model SHA-256 pin | Yes (per CLAUDE.md "MODEL HASHES ARE PINNED") | Computed after upload to HF |

## Architecture

### Before

```
kesha say "..."  (lang=ru)
  → engine: voices::resolve_voice("ru-ruslan") → ResolvedVoice::Piper
  → say() → g2p::text_to_ipa("ru") → g2p_espeak::text_to_ipa_espeak (subprocess to espeak-ng)
  → say_with_piper() → piper::Piper::infer_with_speed (ONNX)
  → wav::encode_wav → stdout
```

### After

```
kesha say "..."  (lang=ru)
  → engine: voices::resolve_voice("ru-vosk-m02") → ResolvedVoice::Vosk { model_path, speaker_id: 4 }
  → say() → say_with_vosk() → vosk_tts::Synth::synth(text, speaker_id) (ONNX, BERT G2P inside)
  → wav::encode_wav → stdout
```

Vosk handles text normalization, G2P (with stress + palatalization), and synthesis as one black box behind the `vosk-tts-rs` crate API. No external G2P call, no separate phonemizer module.

### Voice ID convention

Voice ids are pattern-based (matches existing Piper convention):

| Voice ID | speaker_id | Description |
|---|---|---|
| `ru-vosk-f01` | 0 | Tiflocomp Irina (female) |
| `ru-vosk-f02` | 1 | Natasha-from-Sova (female) |
| `ru-vosk-f03` | 2 | Artificial (female) |
| `ru-vosk-m01` | 3 | Artificial (male) |
| `ru-vosk-m02` | 4 | Artificial (male) — **default** |

`voices::resolve_vosk_ru(cache_dir, voice_id, name)` parses the suffix and returns `ResolvedVoice::Vosk { model_path, speaker_id }`. Unknown suffix errors loudly with the canonical 5 listed.

## Components

### Files to add

- `rust/src/tts/vosk.rs` (~50-100 LoC) — thin wrapper around `vosk_tts::Synth`. Owns model load + per-call synth. Exposes `Vosk::load(path) -> Self` and `Vosk::infer(text, speaker_id, rate) -> Vec<f32>`.

### Files to modify

- `rust/Cargo.toml` — add `vosk-tts-rs = "0.1.0"` (or git pin if heavy server deps aren't feature-gated; resolve at integration). Drop `misaki-rs`'s russian dispatch path expectation.
- `rust/src/tts/mod.rs` — remove `pub mod g2p_espeak`, `pub mod piper`. Add `pub mod vosk`. Remove `EngineChoice::Piper`, `say_with_piper`, `synth_segments_piper`, `synth_ipa_piper`. Add `EngineChoice::Vosk { model_path, speaker_id, rate }`, `say_with_vosk`, `synth_segments_vosk` (SSML segmentation; vosk supports text directly so segments are trivially `text → synth`).
- `rust/src/tts/g2p.rs` — remove CharsiuG2P (`G2pSessions`, `g2p_word`, `tokenize`/`detokenize`, `charsiu_lang`, `text_to_ipa_charsiu`). Remove `super::g2p_espeak::*` dispatch. `text_to_ipa` shrinks to: misaki-rs for English, error otherwise (vosk callers don't go through `text_to_ipa`).
- `rust/src/tts/voices.rs` — remove `ResolvedVoice::Piper` and `resolve_piper_ru`. Add `ResolvedVoice::Vosk { model_path, speaker_id }` and `resolve_vosk_ru`. Update `resolve_voice` `match` to dispatch `ru` to Vosk. Tests get refreshed with vosk fixtures.
- `rust/src/models.rs` — remove `piper_ru_manifest()` and `g2p_onnx_manifest()` (CharsiuG2P). Add `vosk_ru_manifest()` listing the 6 files below from `https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/`. Update `manifest_for_features()` to wire it in.

  | File | Size | SHA-256 |
  |---|---:|---|
  | `model.onnx` | 179 MB | `0fa5a36b22a8bf7fe7179a3882c6371d2c01e5317019e717516f892d329c24b9` |
  | `dictionary` | 101 MB | `2939e72c170bb41ac8e256828cca1c5fac4db1e36717f9f53fde843b00a220ba` |
  | `config.json` | 2.4 KB | `e155fb266a730e1858a2420442b465acf08a3236dffad7d1a507bf155b213d50` |
  | `bert/model.onnx` | 654 MB | `2e2f1740eaae5e29c2b4844625cbb01ff644b2b5fb0560bd34374c35d8a092c1` |
  | `bert/vocab.txt` | 1.8 MB | `bbe5063cc3d7a314effd90e9c5099cf493b81f2b9552c155264e16eeab074237` |
  | `README.md` | 1.2 KB | `e9db06085c65064c6f8e5220a85070f14fdf47bb8018d0b5c07cc0218cbb5a41` |

  Total: ~935 MB. README.md is bundled for reproducibility (license + speaker map).
- `rust/src/main.rs` — `list_piper_ru_voices` → `list_vosk_ru_voices` (or unify into `list_ru_voices`). Update install/status output to mention vosk paths.
- `src/cli/say.ts` — update `pickVoiceForLang`: non-darwin `ru` → `ru-vosk-m02`. darwin keeps Milena. Update doc comment to reflect that Vosk now works (Milena workaround retained for zero-install convenience).
- `src/status.ts` — directory paths from `models/piper-ru` → `models/vosk-ru`.
- `tests/unit/say.test.ts` — assert linux/win32 → `ru-vosk-m02`.

### Files to delete

- `rust/src/tts/g2p_espeak.rs` (entire file — landed in PR #210, ~150 LoC)
- `rust/src/tts/piper.rs` (entire file — Piper engine, ~190 LoC)
- Any cargo example or fixture scoped to Piper-ru.

### CI changes

- `.github/workflows/ci.yml`: drop `🗣️ Install espeak-ng` step from `tts-e2e`. Bump `kokoro-spike-v4` → `kokoro-spike-v5`.
- `.github/workflows/rust-test.yml`: drop OS-specific espeak install step. Bump cache key v4 → v5.
- `rust/ci/download-kokoro.sh`:
  - Drop the Piper-ru block (`ru_RU-ruslan-medium*` URL).
  - Drop the CharsiuG2P block (3 ONNX files).
  - Add the Vosk-ru block (downloads the 6 files listed in the manifest table above into `models/vosk-ru/{model.onnx,dictionary,config.json,bert/model.onnx,bert/vocab.txt,README.md}`).
- `rust/ci/run-cargo-test.sh`: drop `PIPER_MODEL`/`PIPER_CONFIG` exports. Add `VOSK_MODEL` if vosk's gated tests need it.

### Documentation

- `README.md` (TTS section): two engines now — Kokoro (en) + Vosk (ru), AVSpeech (`macos-*`) opt-in. No system deps line restored.
- `docs/tts.md`: full refresh — engines table, voice catalogue, install size, no espeak/CharsiuG2P mentions.
- `BENCHMARK.md`: G2P section now describes "Vosk-ru handles its own G2P internally; misaki-rs covers English". CharsiuG2P numbers move to a "historical" subsection or get removed.
- `CLAUDE.md`: refresh the TTS architecture block:
  - G2P split: English → misaki-rs (no system deps); Russian → Vosk internal (no system deps); other languages → none yet.
  - Voice routing: extend `pickVoiceForLang` documentation with Vosk default.
  - ONNX I/O for Vosk model (input/output names, dtypes — pulled from the model file at integration time).
  - Drop the "PR #210 espeak-ng" install requirement note.
- `raycast/README.md`: G2P note → "English uses misaki-rs (embedded lexicon); Russian uses Vosk-tts (embedded G2P + ONNX). No system deps."

## Risks

1. **vosk-tts-rs pulls heavy deps unconditionally.** Cargo.toml shows `reqwest+tokio+clap+serde_json+log+env_logger` as dependencies (not feature-gated). If `cargo add vosk-tts-rs` adds tens of MB of unused server code to our binary, mitigation is one of:
   - Open issue/PR upstream to feature-gate `server` and `cli` modules behind features.
   - Vendor only `model.rs` + `synth.rs` + `g2p.rs` modules (Apache 2.0 allows it).
   - Live with the bloat (least preferred — bloats kesha-engine binary by an unknown amount).

   Decided at integration: do `cargo build --release` after `cargo add` and see binary size delta. If +20 MB or less, accept. If +50 MB+, vendor.

2. **Speaker ID stability between 0.7 and 0.9.** HF samples are 0.7 and we need to confirm M02 = speaker_id 4 in 0.9. Verify after download by synthesizing all 5 ids with the test phrase and comparing to HF 0.7 samples by ear (or by metadata if the 0.9 zip ships speaker labels).

3. **Model size on disk.** 0.9 zip is ~750 MB, but the unpacked ONNX model size is unknown until we extract. If it's ~600 MB+ (similar to 0.7's `D_1000.pth=578MB`), `kesha install --tts` total grows from ~490 MB to ~700-850 MB. Acceptable but document.

4. **vosk-tts-rs maturity.** 0 stars, 0 forks, single author, last commit Apr 14 2026. Mitigation: pin exact version `=0.1.0`, test thoroughly, be ready to vendor if upstream goes stale.

5. **HF mirror vs upstream divergence.** If `alphacephei` ships 0.10-multi, our HF mirror is stale. Mitigation: the SHA-256 pin protects us from silent change on our HF; explicitly bumping to a new version is a deliberate PR. Document the mirror process for future bumps.

## Acceptance criteria

- [ ] `kesha install --tts` succeeds end-to-end on macOS arm64 with no system deps installed (no `brew install espeak-ng`, no other dynamic libs).
- [ ] Total install size ≤ 1 GB.
- [ ] `kesha say "Привет, мир."` on Linux/Windows produces audio rated by a native Russian speaker as clearly intelligible (verified via Telegram round-trip).
- [ ] `kesha say --voice ru-vosk-m02 "Привет, как дела? Это тест."` has audible question intonation at the end and an audible pause between sentences.
- [ ] All 5 voice ids (`ru-vosk-f01..f03`, `ru-vosk-m01..m02`) synthesize without errors and produce non-empty WAVs at 22050 Hz.
- [ ] `kesha say --list-voices` includes the 5 vosk-ru voices alongside `en-am_michael` (and any other downloaded `am_*`/`bm_*`).
- [ ] No regression on English: `kesha say --voice en-am_michael "Hello, world. This is a test."` still works through the misaki-rs + Kokoro pipeline.
- [ ] `cargo test --release --features onnx,tts --no-default-features` — all tests pass.
- [ ] `bun test && bunx tsc --noEmit` — clean.
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings` — clean.
- [ ] CI green on macos-14, ubuntu-latest, windows-latest.
- [ ] Greptile P1/P2 findings resolved before merge.

## PR plan

Single feature branch (rename `fix/piper-ru-espeak-passthrough` → `fix/replace-piper-with-vosk-ru` since #210's espeak code is now being deleted in the same PR). Logical commits:

1. `feat(tts): add vosk-tts engine for Russian (closes #210, refs #207)` — new module + manifest + integration plumbing.
2. `refactor(tts): remove Piper engine` — delete `piper.rs`, `ResolvedVoice::Piper`, `say_with_piper`, Piper manifest, ru_RU-ruslan voice.
3. `refactor(tts): remove CharsiuG2P + espeak fallback` — delete `g2p_espeak.rs`, CharsiuG2P internals from `g2p.rs`, charsiu manifest. `text_to_ipa` shrinks to misaki-rs only.
4. `chore(ci): drop espeak install + bump cache key` — workflow cleanup.
5. `docs: refresh TTS architecture for vosk-ru` — README, docs/tts.md, BENCHMARK.md, CLAUDE.md, raycast/README.md.
6. (optional) `chore(deps): pin vosk-tts-rs to =0.1.0` — separate hash-pin commit per CLAUDE.md model-pinning vibe applied to the crate (transitive bump guard).

Estimated PR size: ~10-15 files changed, +400/-700 LoC (more deletions than additions because we're collapsing two parallel paths into one).

## Out of scope (separate follow-ups)

- Multilingual Kokoro for fr/it/es/pt-br: tracked in #212.
- Misaki-compatible long-term G2P for Kokoro English: tracked in #208.
- INT8 quantization of vosk-tts-ru model: open follow-up issue if disk size is a perceived problem after release.
- Voice cloning via CosyVoice 3 or similar: open issue if there's user demand; rejected here for being multi-week.
- Mirroring strategy for future model updates (0.10+): document in CLAUDE.md when the next bump happens.

## References

- alphacephei.com/vosk/models/vosk-model-tts-ru-0.9-multi.zip (upstream)
- huggingface.co/alphacep/vosk-tts-ru-multi (HF, 0.7 only)
- huggingface.co/drakulavich/vosk-tts-ru-0.9-multi (our 0.9 mirror, created 2026-04-27)
- github.com/andreytkachenko/vosk-tts-rs (Rust crate, Apache 2.0, ort 2.0.0-rc.12)
- github.com/alphacep/vosk-tts (upstream Python package + training)
- Telegram msg 378-382 (HF 0.7 samples used to pick M02)
- Issue #207 (Kokoro 4-bug bisection — English path closed in PR #211)
- Issue #210 (Piper-ru espeak fix — superseded by this design)
- Issue #212 (Multi-lang Kokoro — depends on espeak path that this PR removes; revisit after merge)
- CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE", "MODEL HASHES ARE PINNED", "VERIFY THIRD-PARTY MODEL FORMATS WITH A SPIKE"
