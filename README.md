# 🦜 parakeet-cli

[![npm version](https://img.shields.io/npm/v/@drakulavich/parakeet-cli)](https://www.npmjs.com/package/@drakulavich/parakeet-cli)
[![CI](https://github.com/drakulavich/parakeet-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/drakulavich/parakeet-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![Test Report](https://img.shields.io/badge/Test_Report-Allure-orange)](https://drakulavich.github.io/parakeet-cli/reports/allure)

Fast local speech-to-text. 25 languages. ~18x faster than Whisper on Apple Silicon.

```bash
bun install -g @drakulavich/parakeet-cli
parakeet install
parakeet audio.ogg  # → transcript to stdout
```

## Highlights

- **CoreML on Apple Silicon** — ~155x real-time via [FluidAudio](https://github.com/FluidInference/FluidAudio)
- **ONNX on CPU** — cross-platform fallback, 3x faster than Whisper ([benchmark](BENCHMARK.md))
- **25 languages** — auto-detected, no prompting
- **Any audio format** — ffmpeg handles OGG, MP3, WAV, FLAC, M4A
- **Zero Python** — Bun + TypeScript, native Swift binary for CoreML

## Usage

```bash
parakeet install                 # auto-detects: CoreML on macOS arm64, ONNX elsewhere
parakeet install --coreml        # force CoreML
parakeet install --onnx          # force ONNX (~3GB)
parakeet audio.ogg               # transcribe (language auto-detected)
parakeet --version
```

Stdout: transcript. Stderr: errors. Pipe-friendly.

## Benchmark

MacBook Pro M3 Pro — 10 Russian voice messages:

| | faster-whisper (CPU) | Parakeet (CoreML) |
|---|---|---|
| **Total** | 35.3s | 1.9s |
| **Speed** | | **~18x faster** |

Full results with transcripts: [BENCHMARK.md](BENCHMARK.md)

## Supported Languages

| | | | | |
|---|---|---|---|---|
| :bulgaria: Bulgarian | :croatia: Croatian | :czech_republic: Czech | :denmark: Danish | :netherlands: Dutch |
| :gb: English | :estonia: Estonian | :finland: Finnish | :fr: French | :de: German |
| :greece: Greek | :hungary: Hungarian | :it: Italian | :latvia: Latvian | :lithuania: Lithuanian |
| :malta: Maltese | :poland: Polish | :portugal: Portuguese | :romania: Romanian | :ru: Russian |
| :slovakia: Slovak | :slovenia: Slovenian | :es: Spanish | :sweden: Swedish | :ukraine: Ukrainian |

## How It Works

```
parakeet audio.ogg
  ├── CoreML installed? → parakeet-coreml subprocess → stdout
  └── ONNX installed?   → ffmpeg → mel → encoder → decoder → stdout
```

- **CoreML**: Pre-built Swift binary wraps [FluidAudio](https://github.com/FluidInference/FluidAudio) + [CoreML model](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml)
- **ONNX**: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) via [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)

## Requirements

- [Bun](https://bun.sh) >= 1.3
- [ffmpeg](https://ffmpeg.org) in PATH (ONNX backend only)
- ~3GB disk (ONNX models)

## OpenClaw Integration

Drop-in replacement for OpenClaw voice processing — no API keys, runs locally.

```json
{
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": [{"type": "cli", "command": "parakeet", "args": ["{{MediaPath}}"], "timeoutSeconds": 120}],
        "echoTranscript": false
      }
    }
  }
}
```

## License

MIT
