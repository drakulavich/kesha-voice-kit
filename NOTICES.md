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

### Piper voices (Russian: `ru-denis`)

Text-to-speech (multilingual, Piper VITS). MIT. Voice packs from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices).

### CharsiuG2P ByT5-tiny (ONNX export)

Grapheme-to-phoneme conversion for Kokoro and Piper pipelines (#123).

**License: CC-BY 4.0** (declared on the ONNX-export repo). Attribution required.

- ONNX export: [klebster/g2p_multilingual_byT5_tiny_onnx](https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx) by Kleber Noel — CC-BY 4.0.
- Base checkpoint: [charsiu/g2p_multilingual_byT5_tiny_16_layers_100](https://huggingface.co/charsiu/g2p_multilingual_byT5_tiny_16_layers_100) — **no explicit license declared on HuggingFace**; usage here follows the CC-BY 4.0 declared by the downstream export and the paper's terms.
- Paper: Zhu, J., Zhang, C., & Jurgens, D. (2022). "ByT5 model for massively multilingual grapheme-to-phoneme conversion." [arXiv:2204.03067](https://arxiv.org/abs/2204.03067) · Interspeech 2022.

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
