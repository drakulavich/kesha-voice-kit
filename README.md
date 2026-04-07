# parakeet-cli

[![npm version](https://img.shields.io/npm/v/@drakulavich/parakeet-cli)](https://www.npmjs.com/package/@drakulavich/parakeet-cli)
[![CI](https://github.com/drakulavich/parakeet-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/drakulavich/parakeet-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)

Fast multilingual speech-to-text CLI powered by NVIDIA Parakeet models. Zero Python. CoreML on Apple Silicon, ONNX on CPU.

## Features

- **25 languages** — automatic language detection, no prompting needed
- **~155x real-time on Apple Silicon** — CoreML backend via [FluidAudio](https://github.com/FluidInference/FluidAudio) (1 min audio in ~0.4s)
- **3x faster than Whisper** on CPU with ONNX fallback (see [benchmark](#benchmark))
- **Zero Python** — pure TypeScript/Bun, native Swift binary for CoreML
- **Smart install** — `parakeet install` auto-detects platform: CoreML on macOS arm64, ONNX elsewhere
- **Any audio format** — ffmpeg handles OGG, MP3, WAV, FLAC, M4A, etc.

## Install

Using Bun (recommended):

```bash
bun install -g @drakulavich/parakeet-cli
```

Using npm (requires Bun runtime installed):

```bash
npm install -g @drakulavich/parakeet-cli
```

Or clone and link locally:

```bash
git clone https://github.com/drakulavich/parakeet-cli.git
cd parakeet-cli
bun install
bun link
```

> **Note:** Bun is required as the runtime — the CLI uses Bun-native APIs and TypeScript execution. You can use either `bun` or `npm` as the package manager to install it, but Bun must be available in PATH to run the `parakeet` command.

## Usage

```bash
# Download backend (required before first use)
# On macOS Apple Silicon: downloads CoreML binary
# On Linux/other: downloads ONNX models (~3GB)
parakeet install

# Force a specific backend
parakeet install --coreml    # CoreML (macOS arm64 only)
parakeet install --onnx      # ONNX (any platform)

# Transcribe any audio file (language auto-detected)
parakeet audio.ogg

# Force re-download
parakeet install --no-cache

# Show version
parakeet --version
```

Output goes to stdout, errors to stderr. Designed for piping and scripting.

## Benchmark

10 Telegram voice messages (Russian, 3-10s each) on MacBook Pro M3 Pro:

| | faster-whisper (CPU) | Parakeet (CoreML) |
|---|---|---|
| **Total time** | 35.3s | 1.9s |
| **Speedup** | | **~18x faster** |

Models: faster-whisper medium (int8) vs Parakeet TDT 0.6B v3 (CoreML, Apple Neural Engine).

See [BENCHMARK.md](BENCHMARK.md) for full results with transcripts. Updated automatically on each release.

## Supported Languages

Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.

## How It Works

### CoreML backend (macOS Apple Silicon)

```
parakeet audio.ogg
  |
  +-- parakeet-coreml (Swift binary via FluidAudio)
  |   +-- CoreML inference on Apple Neural Engine
  |   +-- ~155x real-time on M4 Pro
  |
  stdout: transcript
```

Uses [FluidAudio](https://github.com/FluidInference/FluidAudio) with the [CoreML model](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml). CoreML model files are downloaded by FluidAudio on first transcription.

### ONNX backend (cross-platform fallback)

```
parakeet audio.ogg
  |
  +-- ffmpeg: any format -> 16kHz mono float32
  +-- nemo128.onnx: waveform -> 128-dim log-mel spectrogram
  +-- per-utterance normalization (mean=0, std=1)
  +-- encoder-model.onnx: mel features -> encoder output
  +-- TDT greedy decoder: encoder output -> token IDs + durations
  +-- vocab.txt: token IDs -> text
  |
  stdout: transcript
```

Uses [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) exported to ONNX by [istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx). Run `parakeet install --onnx` to download models from HuggingFace (~3GB).

## Requirements

- [Bun](https://bun.sh) >= 1.3 (runtime)
- [ffmpeg](https://ffmpeg.org) installed and in PATH
- ~3GB disk space for model cache
- npm or Bun can be used as the package manager

### macOS (Apple Silicon)

Works natively on M1/M2/M3/M4 with CoreML acceleration. Install dependencies with Homebrew:

```bash
brew install ffmpeg
curl -fsSL https://bun.sh/install | bash
bun install -g @drakulavich/parakeet-cli    # or: npm install -g @drakulavich/parakeet-cli
parakeet install                             # downloads CoreML binary
```

### Linux

```bash
apt install ffmpeg   # or yum, pacman, etc.
curl -fsSL https://bun.sh/install | bash
bun install -g @drakulavich/parakeet-cli    # or: npm install -g @drakulavich/parakeet-cli
parakeet install                             # downloads ONNX models (~3GB)
```

## OpenClaw Integration

To use parakeet as the voice transcription engine in [OpenClaw](https://docs.openclaw.ai), update `~/.openclaw/openclaw.json`:

```json
"tools": {
  "media": {
    "audio": {
      "enabled": true,
      "models": [
        {
          "type": "cli",
          "command": "parakeet",
          "args": ["{{MediaPath}}"],
          "timeoutSeconds": 120
        }
      ],
      "echoTranscript": false
    }
  }
}
```

Then restart the gateway: `openclaw gateway restart`

## License

MIT
