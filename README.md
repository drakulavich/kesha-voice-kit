# Kesha Voice Kit

[![CI](https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@drakulavich/kesha-voice-kit)](https://www.npmjs.com/package/@drakulavich/kesha-voice-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)

**Open-source voice toolkit for Apple Silicon.** A collection of small, fast, open-source audio models — packaged as CLI tools and an [OpenClaw](https://github.com/nicekid1/OpenClaw) skill for LLM agents.

- **Speech-to-text** — 25 languages, ~18x faster than Whisper on Apple Silicon
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

### Voice message processing

```json
{
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": [
          {
            "type": "cli",
            "command": "kesha",
            "args": ["{{MediaPath}}"],
            "timeoutSeconds": 120
          }
        ],
        "echoTranscript": false
      }
    }
  }
}
```

Your agent receives a voice message in Telegram/WhatsApp/Slack. OpenClaw pipes it through Kesha, feeds the transcript to the LLM. The user speaks, the agent understands.

### Language-aware processing

```json
{
  "type": "cli",
  "command": "kesha",
  "args": ["--json", "{{MediaPath}}"]
}
```

JSON output includes detected language — your agent knows what language the user spoke and can respond accordingly:

```json
[{
  "file": "voice.ogg",
  "text": "Привет, как дела?",
  "lang": "ru",
  "textLanguage": { "code": "ru", "confidence": 0.99 }
}]
```

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
| NVIDIA Parakeet TDT 0.6B v3 | Speech-to-text | ~86MB | [HuggingFace](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| SpeechBrain ECAPA-TDNN | Audio language detection | ~86MB | [HuggingFace](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa) |
| Apple NLLanguageRecognizer | Text language detection | built-in | macOS system framework |

All models run through `kesha-engine` — a Rust binary using [FluidAudio](https://github.com/FluidInference/FluidAudio) (CoreML) on Apple Silicon and [ort](https://github.com/pykeio/ort) (ONNX Runtime) on other platforms.

## Performance

> **~18x faster than Whisper** on Apple Silicon

<details>
<summary>MacBook Pro M3 Pro — 10 Russian voice messages</summary>

```
faster-whisper (CPU):  35.3s  ██████████████████████████████████████
Kesha (CoreML):         1.9s  ██
```

| | faster-whisper | Kesha | Speedup |
|---|---|---|---|
| Apple Silicon (CoreML) | 35.3s | **1.9s** | **~18x** |
| Linux CI (ONNX) | 79.2s | **45.4s** | **~1.7x** |

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
- ~200MB disk (engine + models)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Made with 💛🩵 Published under MIT License.
