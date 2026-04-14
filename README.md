<p align="center">
  <img src="assets/logo.png" alt="Kesha Voice Kit" width="200">
</p>

<h1 align="center">Kesha Voice Kit</h1>

<p align="center">
  <a href="https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml"><img src="https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@drakulavich/kesha-voice-kit"><img src="https://img.shields.io/npm/v/@drakulavich/kesha-voice-kit" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun"></a>
</p>

<p align="center"><b>Open-source voice toolkit for Apple Silicon.</b><br>A collection of small, fast, open-source audio models — packaged as CLI tools and an <a href="https://github.com/nicekid1/OpenClaw">OpenClaw</a> skill for LLM agents.</p>

- **Speech-to-text** — 25 languages, ~19x faster than Whisper on Apple Silicon
- **Language detection** — 107 languages from audio, text language via NLLanguageRecognizer
- **Rust engine** — single 20MB binary, no ffmpeg, no Python, no native Node addons
- **OpenClaw-ready** — plug into your LLM agent as a voice processing skill

## Quick Start

```bash
bun install -g @drakulavich/kesha-voice-kit
kesha install       # downloads engine + models
kesha audio.ogg     # transcript to stdout
```

## OpenClaw Integration

Kesha Voice Kit is built as a skill for [OpenClaw](https://github.com/nicekid1/OpenClaw) — give your LLM agent ears. No API keys, everything runs locally on your machine.

Add to your OpenClaw config:

```json
{
  "type": "cli",
  "command": "kesha",
  "args": ["--json", "{{MediaPath}}"]
}
```

Your agent receives a voice message in Telegram/WhatsApp/Slack. Kesha transcribes it locally, detects the language, and returns structured JSON:

```json
[{
  "file": "voice.ogg",
  "text": "Привет, как дела?",
  "lang": "ru",
  "textLanguage": { "code": "ru", "confidence": 0.99 }
}]
```

The agent knows what was said and in what language — and can respond accordingly.

## CLI Tools

```bash
kesha install                    # download engine and models
kesha audio.ogg                  # transcribe
kesha --json audio.ogg           # JSON output with language info
kesha --verbose audio.ogg        # show language detection details
kesha --lang en audio.ogg        # warn if detected language differs
kesha status                     # show installed backend info
```

Stdout: transcript. Stderr: errors. Pipe-friendly.

**Also available as `parakeet` command** (backward-compatible alias).

## What's Inside

Kesha Voice Kit bundles open-source models optimized for on-device inference:

| Model | Task | Size | Source |
|---|---|---|---|
| NVIDIA Parakeet TDT 0.6B v3 | Speech-to-text | ~2.5GB | [HuggingFace](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| SpeechBrain ECAPA-TDNN | Audio language detection | ~86MB | [HuggingFace](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa) |
| Apple NLLanguageRecognizer | Text language detection | built-in | macOS system framework |

All models run through `kesha-engine` — a Rust binary using [FluidAudio](https://github.com/FluidInference/FluidAudio) (CoreML) on Apple Silicon and [ort](https://github.com/pykeio/ort) (ONNX Runtime) on other platforms.

## Performance

> **~19x faster than Whisper** on Apple Silicon, **~2.5x faster** on CPU

Compared against Whisper `large-v3-turbo` — all engines auto-detect language.

![Benchmark: openai-whisper vs faster-whisper vs Kesha Voice Kit](assets/benchmark.svg)

<details>
<summary>Full results with per-file breakdown</summary>

See [BENCHMARK.md](BENCHMARK.md) — includes Russian (real voice messages) and English transcription results with all four engines.

</details>

## Supported Audio Formats

Built-in audio decoding via [symphonia](https://github.com/pdeljanov/Symphonia) — no ffmpeg required:

| Format | Extension |
|---|---|
| WAV | `.wav` |
| MP3 | `.mp3` |
| OGG Vorbis/Opus | `.ogg`, `.opus` |
| FLAC | `.flac` |
| AAC / M4A | `.aac`, `.m4a` |

## Supported Languages

**Speech-to-text (25):** :bulgaria: Bulgarian, :croatia: Croatian, :czech_republic: Czech, :denmark: Danish, :netherlands: Dutch, :gb: English, :estonia: Estonian, :finland: Finnish, :fr: French, :de: German, :greece: Greek, :hungary: Hungarian, :it: Italian, :latvia: Latvian, :lithuania: Lithuanian, :malta: Maltese, :poland: Polish, :portugal: Portuguese, :romania: Romanian, :ru: Russian, :slovakia: Slovak, :slovenia: Slovenian, :es: Spanish, :sweden: Swedish, :ukraine: Ukrainian

**Audio language detection (107):** Full list at [speechbrain/lang-id-voxlingua107-ecapa](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa)

## Architecture

```
kesha audio.ogg
  → kesha-engine (Rust binary)
    ├── Apple Silicon? → FluidAudio (CoreML / Neural Engine)
    └── Other?        → ort (ONNX Runtime / CPU)
  → transcript to stdout
```

## Programmatic API

```typescript
import { transcribe, downloadModel } from "@drakulavich/kesha-voice-kit/core";

await downloadModel();                    // install engine + models
const text = await transcribe("audio.ogg"); // transcribe
```

## Requirements

- [Bun](https://bun.sh) >= 1.3
- macOS arm64, Linux x64, or Windows x64

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Made with 💛🩵 Published under MIT License.
