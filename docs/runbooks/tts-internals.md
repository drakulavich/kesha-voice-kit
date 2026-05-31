# TTS Internals Runbook

> Extracted from CLAUDE.md (chore/slim-claudemd, 2026-05-31) to keep the always-loaded
> instructions under Claude Code's 40k-char performance threshold. Read this when changing
> TTS synthesis, voices, G2P, or SSML.

## Engines

Text-to-speech via three engines selected by voice id prefix:

- `en-*` → **Kokoro-82M**. Separate model + per-voice style embedding. Output 24 kHz.
- `ru-*` → **Vosk-TTS** (`alphacep/vosk-tts`). Multi-speaker model, 5 baked-in speakers. Output 22.05 kHz.
- `macos-*` → **AVSpeechSynthesizer** Swift sidecar (#141). Zero model download, notification-grade quality, darwin-arm64 release feature set `coreml,tts,system_tts`; `kesha install` places `say-avspeech-darwin-arm64` next to the engine and runtime lookup is sibling-first (`rust/src/tts/avspeech.rs::helper_path`).

Install Kokoro + Vosk-TTS explicitly with `kesha install --tts` (~990 MB). `macos-*` voices use installed macOS voices and need no model install.

## Behavior, G2P, and SSML

- TTS models are **never auto-downloaded** — `kesha say` fails loudly with a `kesha install --tts` hint when models are missing.
- `kesha say` writes WAV mono f32 to stdout unless `--out` is given. Stderr is progress/errors only.
- G2P split (post-#213): English (`en`/`en-us`/`en-gb`) uses embedded `misaki-rs` (Kokoro-trained inventory, no system deps, OOV letter-spell); Russian uses Vosk-TTS internals (BERT prosody + dictionary, no system deps); other shipped engines are unsupported ([#212](https://github.com/drakulavich/kesha-voice-kit/issues/212)). CharsiuG2P ([#123](https://github.com/drakulavich/kesha-voice-kit/issues/123)) and espeak-ng ([#210](https://github.com/drakulavich/kesha-voice-kit/issues/210)) were removed in [#213](https://github.com/drakulavich/kesha-voice-kit/issues/213).
- Auto-routing: omitted `--voice` calls TS `NLLanguageRecognizer` and picks `en-am_michael`, `macos-com.apple.voice.compact.ru-RU.Milena` on darwin Russian, or `ru-vosk-m02` elsewhere. Confidence < 0.5 or unmapped language falls to engine default. Routing table: `src/cli/say.ts::pickVoiceForLang`.
- SSML (`--ssml`): `ssml-parser`; supports required `<speak>` root and `<break time="...">`; rejects `<!DOCTYPE>`; unknown tags (`<emphasis>`, `<prosody>`, `<phoneme>`, `<say-as>`) warn once and strip tags while synthesizing contained text. `tts::ssml::parse` returns `Vec<Segment>`; `tts::say()` loads the engine once, concatenates text/silence f32 samples, then calls `wav::encode_wav`. Scope/future tags: #122.

## ONNX I/O shapes

- Kokoro ONNX (post-#207 official `kokoro-onnx` v1.0): inputs `tokens` int64 `[1,N]`, `style` f32 `[1,256]` rank-2, `speed` f32 `[1]`; output `"audio"`; voice file 510x256. The earlier HF onnx-community variant used `input_ids`/`waveform` and broke `af_heart`.
- Vosk-TTS ONNX (post-#213): one `Synth` + `Model` per call (`Vosk::load`: `model.onnx`, `bert/model.onnx`, dictionary, ~1-2s cold). `Model::new` takes `Option<&str>` dir; `Synth::synth_audio` returns i16 PCM at model sample rate (22050 Hz for `vosk-model-tts-ru-0.9-multi`); `rust/src/tts/vosk.rs` converts to f32 / 32768.0. Speakers 0..4 map to `ru-vosk-{f01,f02,f03,m01,m02}` in `voices::resolve_vosk_ru`; multi-call perf tracked in #213.
- AVSpeech (#141, `system_tts`, default darwin-arm64): engine spawns `say-avspeech`; path resolution tries sibling-of-exe (`~/.cache/kesha/bin/say-avspeech`) then build-time `$OUT_DIR/say-avspeech`. stdin UTF-8, argv[1] voice id, `--list-voices` emits `identifier|language|name`, Rust prefixes `macos-` and merges into `say --list-voices`. Output: complete mono f32 IEEE_FLOAT WAV @ 22050 Hz. Must pump `CFRunLoopRun()` because callbacks dispatch on main queue; `DispatchSemaphore` hangs. `--rate` mapping TBD; SSML + AVSpeech rejected in v1.

## Environment variables

- `KESHA_ENGINE_BIN` — override the engine-binary path (useful when iterating on `rust/target/release/kesha-engine`).
- `KESHA_CACHE_DIR` — isolated test cache.
- `KESHA_MODEL_MIRROR` — redirect HF downloads to an internal mirror (#121), preserving `/<owner>/<repo>/resolve/<ref>/<file>` for `wget --mirror`; empty/unset = no-op. Rust `models.rs::apply_mirror` and TS `status.ts::activeModelMirror` both trim trailing slashes.
- macOS dev runtime: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`. Release binaries fix up via `install_name_tool`.
- macOS build env: `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib`, `RUSTFLAGS="-L /opt/homebrew/lib"`.

## History

Original spec assumed Silero TTS; pivoted to Piper during M3 spike (Silero ships PyTorch-only, no public ONNX). See `docs/superpowers/specs/2026-04-16-bidirectional-voice-design.md`.
