---
name: tts-internals
description: Use when working on kesha TTS internals — voice routing and which engine serves which voice-id prefix, Kokoro/Vosk ONNX I/O shapes, the CharsiuG2P vs FluidAudio G2P split, SSML handling, multilingual behaviour (es/fr/it/pt on ONNX, hi/ja/zh on darwin-arm64), or the KESHA_* TTS environment variables. Explains why darwin-arm64 routes differently from every other build.
---

# TTS internals

## Engines

Text-to-speech via three engines selected by voice id prefix:

- `en-*` → **Kokoro-82M**. Separate model + per-voice style embedding. Output 24 kHz.
- `ru-*` → **Vosk-TTS** (`alphacep/vosk-tts`). Multi-speaker model, 5 baked-in speakers. Output 22.05 kHz.
- `macos-*` → **AVSpeechSynthesizer** Swift sidecar (#141). Zero model download, notification-grade quality, darwin-arm64 release feature set `coreml,tts,system_tts`; `kesha install` places `say-avspeech-darwin-arm64` next to the engine and runtime lookup is sibling-first (`rust/src/tts/avspeech.rs::helper_path`).

Install Kokoro + Vosk-TTS explicitly with `kesha install --tts` (~990 MB). `macos-*` voices use installed macOS voices and need no model install.

## Behavior, G2P, and SSML

- TTS models are **never auto-downloaded** — `kesha say` fails loudly with a `kesha install --tts` hint when models are missing.
- `kesha say` writes WAV mono f32 to stdout unless `--out` is given. Stderr is progress/errors only.
- G2P split: English (`en`/`en-us`/`en-gb`) uses embedded `misaki-rs` (Kokoro-trained inventory, no system deps, OOV letter-spell); Russian uses Vosk-TTS internals (BERT prosody + dictionary, no system deps); `es`/`fr`/`it`/`pt` use CharsiuG2P on ONNX builds and FluidAudio's own G2P on darwin-arm64 `system_kokoro` (see below); every other language bails out of `g2p::text_to_ipa_cached` with a pointer to #212 — darwin-arm64 `hi`/`ja`/`zh` never reach that function at all (#492, below). espeak-ng ([#210](https://github.com/drakulavich/kesha-voice-kit/issues/210)) was retired in [#214](https://github.com/drakulavich/kesha-voice-kit/pull/214), which also dropped CharsiuG2P ([#123](https://github.com/drakulavich/kesha-voice-kit/issues/123)) once it had no callers left; CharsiuG2P came back for the Romance languages in [#509](https://github.com/drakulavich/kesha-voice-kit/pull/509), closing [#212](https://github.com/drakulavich/kesha-voice-kit/issues/212).
- Auto-routing: omitted `--voice` calls TS `NLLanguageRecognizer` and picks `en-am_michael`, `macos-com.apple.voice.compact.ru-RU.Milena` on darwin Russian, or `ru-vosk-m02` elsewhere. Confidence < 0.5 or unmapped language falls to engine default. Routing table: `src/voice-routing.ts::pickVoiceForLang`.
- SSML (`--ssml`): `ssml-parser`; supports required `<speak>` root and `<break time="...">`; rejects `<!DOCTYPE>`; unknown tags (`<emphasis>`, `<prosody>`, `<phoneme>`, `<say-as>`) warn once and strip tags while synthesizing contained text. `tts::ssml::parse` returns `Vec<Segment>`; `tts::say()` loads the engine once, concatenates text/silence f32 samples, then calls `wav::encode_wav`. Scope/future tags: #122.

## ONNX I/O shapes

- Kokoro ONNX (post-#207 official `kokoro-onnx` v1.0): inputs `tokens` int64 `[1,N]`, `style` f32 `[1,256]` rank-2, `speed` f32 `[1]`; output `"audio"`; voice file 510x256. The earlier HF onnx-community variant used `input_ids`/`waveform` and broke `af_heart`.
- Vosk-TTS ONNX (post-#214): one `Synth` + `Model` per call (`Vosk::load`: `model.onnx`, `bert/model.onnx`, dictionary, ~1-2s cold). `Model::new` takes `Option<&str>` dir; `Synth::synth_audio` returns i16 PCM at model sample rate (22050 Hz for `vosk-model-tts-ru-0.9-multi`); `rust/src/tts/vosk.rs` converts to f32 / 32768.0. Speakers 0..4 map to `ru-vosk-{f01,f02,f03,m01,m02}` in `voices::resolve_vosk_ru`; multi-call perf tracked in #213.
- AVSpeech (#141, `system_tts`, default darwin-arm64): engine spawns `say-avspeech`; path resolution tries sibling-of-exe (`~/.cache/kesha/bin/say-avspeech`) then build-time `$OUT_DIR/say-avspeech`. stdin UTF-8, argv[1] voice id, `--list-voices` emits `identifier|language|name`, Rust prefixes `macos-` and merges into `say --list-voices`. Output: complete mono f32 IEEE_FLOAT WAV @ 22050 Hz. Must pump `CFRunLoopRun()` because callbacks dispatch on main queue; `DispatchSemaphore` hangs. `--rate` mapping TBD; SSML + AVSpeech rejected in v1.

## Environment variables

- `KESHA_ENGINE_BIN` — override the engine-binary path (useful when iterating on `rust/target/release/kesha-engine`).
- `KESHA_CACHE_DIR` — isolated test cache.
- `KESHA_MODEL_MIRROR` — redirect HF downloads to an internal mirror (#121), preserving `/<owner>/<repo>/resolve/<ref>/<file>` for `wget --mirror`; empty/unset = no-op. Rust `models/download.rs::apply_mirror` and TS `status.ts::activeModelMirror` both trim trailing slashes.
- `KESHA_KOKORO_COMPUTE_UNITS` — `default` (FluidAudio's tuned per-stage mapping; the RNN-bearing Albert/PostAlbert/Alignment/Prosody/Vocoder on the ANE, the all-fp32 Noise and Tail iSTFT on the GPU) · `cpu-and-gpu` · `all-ane` · `cpu-only`. Diagnostic only, and darwin-arm64 `system_kokoro` only: FluidAudio's `KokoroAne.md` recommends the CPU baseline when deciding whether an artefact is the model or the accelerator. Unset is `default`; blank is treated as unset (a conditional GHA `env:` exports an empty string); an unknown value fails before model init rather than falling back to the ANE the caller was avoiding. Nothing in CI sets it — a non-ANE preset does **not** rescue the `macos-14` image, which fails on the vocoder's shape contract regardless (#678). `default` is what makes M5 work out of the box (FluidAudio #667/#671, Noise-on-GPU #677): it is the only routing that keeps the prosody RNN off the GPU, where M5 aborts in `GPURNNOps`, while keeping the tail iSTFT off `libBNNS`. `cpu-and-gpu` deliberately breaks that invariant and must not be set on M5 (#717).
- macOS dev runtime: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`. Release binaries fix up via `install_name_tool`.
- macOS build env: `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib`, `RUSTFLAGS="-L /opt/homebrew/lib"`.

## CharsiuG2P engine (es/fr/it/pt on ONNX builds)

Romance-language G2P uses the **klebster 3-file KV-cache ONNX export** of CharsiuG2P
(Zhu et al. 2022). Three `ort` sessions implement an autoregressive byte-level seq2seq decode:
`encoder_model.onnx` (run once), `decoder_model.onnx` (step 0, seeds all 16 KV presents),
`decoder_with_past_model.onnx` (steps 1..N, 8 rolling decoder KV + 8 constant encoder KV).
License: CC-BY 4.0 (attribution in `NOTICES`).

**Tokenizer:** ByT5 byte-level — input format `"<tag>: word"` where tag is one of
`<spa>` (es), `<fra>` (fr), `<ita>` (it), `<por-bz>` (pt). Each byte maps to
`byte_value + 3` (special-token offset), followed by EOS id 1.

**OOV remap:** Charsiu can emit IPA symbols outside Kokoro's phoneme vocabulary
(tie-bar affricates `t͡s/t͡ʃ/d͡ʒ`, Latin `g` U+0067, pre-composed nasals `õ/ũ/ẽ`).
`tts::charsiu::remap` normalizes these to Kokoro-vocab equivalents (`ʦ/ʧ/ʤ`,
script-g U+0261, NFD base+combining-tilde); locked by a zero-residual-OOV regression test.

**Normalize pass:** numbers and acronyms are expanded before G2P (`512` → `quinientos doce`
in es, etc.) via `tts::normalize::{numbers,acronyms}`. CharsiuG2P collapses raw digits;
the normalizer runs first so digit sentences produce longer, correctly-paced audio.

**IO contract** (PR #185, verified against the pinned export). `encoder_model`: in
`input_ids` int64 `[B,S]` + `attention_mask` int64 `[B,S]`, out `last_hidden_state`
f32 `[B,S,256]`. `decoder_model` (step 0): in `input_ids` + `encoder_attention_mask`
+ `encoder_hidden_states`, out `logits` f32 `[B,S,384]` + 16 `present.{0..3}.{decoder,encoder}.{key,value}`
f32 `[B,6,S,64]`. `decoder_with_past_model` (steps 1..N): in `input_ids` `[B,1]` +
`encoder_attention_mask` + the 16 `past_key_values.*`, out `logits` `[B,1,384]` + only
the 8 **decoder** presents — the encoder K/V are seeded once at step 0 and re-fed
verbatim every step. Decode is greedy, stops on EOS, capped at 128 steps.
Model is ByT5-tiny: `vocab_size` 384, `d_model` 256, 12 encoder / 4 decoder layers,
6 heads. Measured ~36 ms/word single-thread on M2, byte-identical to the Python
reference for es/fr/it/pt.

### Multilingual G2P (#511)

`--lang es-ES` selects Castilian Spanish via `charsiu::is_castilian_region` / `base_lang`
resolution. Because the upstream CharsiuG2P klebster export contains no Castilian θ tag
(confirmed in the #511 Phase-0 spike), the `CASTILIAN` decision constant is set to
`Degrade`: the synthesizer falls back to Latin-American phonology (`<spa>` tag) and emits
a one-time stderr note. `es` / `es-419` / `es-MX` continue to use Latin-American directly
with no warning. Per-language acronym stop-lists (`ES/FR/IT/PT_STOP_LIST` in
`rust/src/tts/normalize/acronyms.rs`) are curated seeds that prevent word-acronyms
(OTAN, OVNI, FIFA…) from being letter-spelled; they are not exhaustive.

## FluidAudio KokoroAne variants — macOS Chinese (#492)

On `system_kokoro` (darwin/ANE), `tts::fluid_kokoro::with_kokoro` resolves the voice's
language (`lang_for_fluid_id`) and passes it to `init_kokoro(voice, lang)`. The fork's
Swift bridge (`fluidaudio-rs`, version pinned in `rust/Cargo.toml`) maps it to a `KokoroAneVariant`:
`zh` → `.mandarin` (tone-aware G2P: jieba + g2pw + bopomofo + tone sandhi), everything
else → `.english` (en plus Latin-script es/fr/it/pt, which the English G2P handles
acceptably). The `.mandarin` variant fetches its own `ANE-zh/` bundle (nested
`voices/<id>.bin`) on first synth — zh voices are therefore **not** staged in
`models/manifest.rs::ANE_KOKORO_VOICES` and are exempt from the staging-coverage test (like
`af_heart`). Default zh voice: `zh-zm_050` (male). Native-script `hi`/`ja` still fail fast
(`E_SCRIPT_UNSUPPORTED`) — no FluidAudio KokoroAne variant for them yet. The
`-Wl,-rpath,/usr/lib/swift` link arg in `build.rs` is emitted under
`coreml`/`system_kokoro`/`system_diarize` so the Swift runtime loads without
`MACOSX_DEPLOYMENT_TARGET=14.0` locally.

## History

Original spec assumed Silero TTS; pivoted to Piper during the M3 spike (Silero ships PyTorch-only, no public ONNX), and Piper was later dropped for the current Kokoro/Vosk/AVSpeech split. The lesson that stuck is CLAUDE.md's "verify third-party model formats with a spike".
