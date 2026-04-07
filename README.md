# parakeet-cli

[![npm version](https://img.shields.io/npm/v/@drakulavich/parakeet-cli)](https://www.npmjs.com/package/@drakulavich/parakeet-cli)
[![CI](https://github.com/drakulavich/parakeet-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/drakulavich/parakeet-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)

Fast multilingual speech-to-text CLI powered by NVIDIA Parakeet ONNX models. Zero Python. Runs on CPU.

## Features

- **25 languages** — automatic language detection, no prompting needed
- **3x faster than Whisper** on CPU (see [benchmark](#benchmark))
- **Zero Python** — pure TypeScript/Bun with onnxruntime-node
- **Explicit model install** — `parakeet install` downloads ~3GB to `~/.cache/parakeet/`
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
# Download models (required before first use)
parakeet install

# Transcribe any audio file (language auto-detected)
parakeet audio.ogg

# Force re-download models
parakeet install --no-cache

# Show version
parakeet --version
```

Output goes to stdout, errors to stderr. Designed for piping and scripting.

## Benchmark

Tested on 10 real Telegram voice messages (Russian, 3-10s each).
VM: AMD EPYC 7763 8C/16T, 64GB RAM, CPU-only.

| # | Whisper | Parakeet | Whisper Transcript | Parakeet Transcript |
|---|---------|----------|--------------------|---------------------|
| 1 | 13.3s | 4.4s | Проверь все свои конфиги и перенеси секреты в .env файл. | проверь все свои конфигии и перенеси секреты в дот энф файл |
| 2 | 13.1s | 4.2s | Вынеси еще секрет от Клода, который я тебе добавил. | неси еще секрет от Клода, который я тебе добавил |
| 3 | 12.7s | 4.0s | Установи пока Клод Код | Установи пока клот кот |
| 4 | 13.1s | 4.1s | Какие еще Telegram-юзеры имеют доступ к тебе? | ки еще телеграм юзеры имеют доступ к тебе |
| 5 | 12.7s | 4.0s | Закомите изменения в ГИТ | Закомить изменения в Гет |
| 6 | 13.1s | 4.1s | Узнай второго юзера в телеграме. | Узнай второго юзера в Телеграме |
| 7 | 13.4s | 5.0s | Ты добавил себе в память информацию из Vantage Handbook Репозитория | Ты добавил себе в память информацию из Вентаж хэндбук репозитория |
| 8 | 13.1s | 4.8s | Покажи его username в телеграмме, хочу написать ему. | жи его юзернейм в телеграме хочу написать ему |
| 9 | 14.2s | 4.5s | Не нужно посылать сообщение с транскрипцией. Сразу выполняй инструкцию. | жно слать сообщение с транскрипцией сразу выполняй инструкцию |
| 10 | 13.5s | 4.8s | То, что находится в папке Workspace, ты тоже коммитишь? | То, что находится в папке Воркспейс, ты тоже комитишь? |
| **Total** | **132.1s** | **43.8s** | | |

**Parakeet is 3x faster.** Whisper handles mixed-language words better (`.env`, `Workspace`). Parakeet transliterates them phonetically. Both produce transcripts usable by LLMs.

Models: Whisper medium (int8) vs Parakeet TDT 0.6B v3 (ONNX, CPU).

## Supported Languages

Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.

## How It Works

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

Uses [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) exported to ONNX by [istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx). Run `parakeet install` to download models from HuggingFace (~3GB).

## Requirements

- [Bun](https://bun.sh) >= 1.3 (runtime)
- [ffmpeg](https://ffmpeg.org) installed and in PATH
- ~3GB disk space for model cache
- npm or Bun can be used as the package manager

### macOS (Apple Silicon)

Works natively on M1/M2/M3/M4. Install dependencies with Homebrew:

```bash
brew install ffmpeg
curl -fsSL https://bun.sh/install | bash
bun install -g @drakulavich/parakeet-cli    # or: npm install -g @drakulavich/parakeet-cli
```

### Linux

```bash
apt install ffmpeg   # or yum, pacman, etc.
curl -fsSL https://bun.sh/install | bash
bun install -g @drakulavich/parakeet-cli    # or: npm install -g @drakulavich/parakeet-cli
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
