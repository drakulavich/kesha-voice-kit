# Third-Party Notices

Kesha Voice Kit itself is MIT-licensed (see `LICENSE`). It bundles or downloads
third-party models and libraries at runtime. Their licenses and attributions
are listed below.

## Models downloaded by `kesha install`

### NVIDIA Parakeet TDT 0.6B v3

Automatic speech recognition. CC-BY 4.0. Trained and published by NVIDIA
Corporation; ONNX export by [istupakov/parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx).

### SpeechBrain ECAPA-TDNN VoxLingua107

Audio language identification. Apache 2.0. Trained by the SpeechBrain team;
see [speechbrain/lang-id-voxlingua107-ecapa](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa).

### Silero VAD v5 (opt-in: `kesha install --vad`)

Voice activity detection. MIT. Authored by [Silero Team](https://github.com/snakers4/silero-vad).
Pinned to the `v6.2.1` tag.

## Models downloaded by `kesha install --tts`

### Kokoro-82M

Text-to-speech (English). Apache 2.0. ONNX export by [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX).

### Vosk-TTS (Russian, multi-speaker)

Text-to-speech (Russian, 5 baked-in speakers). Apache 2.0. Model: [alphacep/vosk-tts](https://huggingface.co/alphacep/vosk-tts) (`vosk-model-tts-ru-0.9-multi`).

**Runtime code:** Originally pulled from `crates.io` as `vosk-tts-rs 0.1.0`. As of #216 the runtime subset is **vendored** under `rust/vendor/vosk-tts/` (Apache 2.0; copied from [`andreytkachenko/vosk-tts-rs`](https://github.com/andreytkachenko/vosk-tts-rs) — see `rust/vendor/vosk-tts/LICENSE` and `rust/vendor/vosk-tts/NOTICE`). The vendored copy drops the upstream gRPC server/CLI/HTTP-model-fetch modules and replaces the `tokenizers` crate with a small inline BERT WordPiece tokenizer, eliminating the `prost`, `tonic`, `tokio`, `axum`, `hyper`, `reqwest`, `tokenizers`, `onig_sys`, `esaxx-rs`, `bzip2-sys`, `lzma-sys`, and `zstd-sys` transitive dependencies that broke Windows MSVC linkage.

### misaki-rs (English G2P)

Embedded grapheme-to-phoneme for English (Kokoro pipeline, #207). MIT. Source: [`misaki-rs`](https://github.com/MicheleYin/misaki-rs).

## System libraries linked by the engine binary

### ONNX Runtime (`ort` / `ort-sys` crates)

MIT. Microsoft. The engine dynamically links a vendored `onnxruntime` shared
library downloaded to `~/Library/Caches/ort.pyke.io/` on first build.

### FluidAudio (`fluidaudio-rs` crate, CoreML backend only)

Apache 2.0. [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio).
Linked into the engine when built with `--features coreml`.

### symphonia

MPL-2.0. [pdeljanov/Symphonia](https://github.com/pdeljanov/Symphonia). Audio
container decoder.

### symphonia-adapter-libopus

MIT OR Apache-2.0. Opus-decoder adapter, by [aschey](https://github.com/aschey/symphonia-adapters).

### libopus

BSD-3-Clause. Upstream Opus codec, by Xiph.Org / the IETF Opus working group. Statically linked via `opusic-sys`.
