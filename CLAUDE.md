# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Parakeet CLI is a fast multilingual speech-to-text tool powered by NVIDIA Parakeet TDT 0.6B ONNX models. It runs entirely locally with no cloud dependencies. Built on Bun runtime with onnxruntime-node for inference.

Two interfaces: a CLI (`parakeet <audio>`) and a programmatic API (`@drakulavich/parakeet-cli/core`).

## Critical Development Rules

### NEVER AUTO-DOWNLOAD MODELS

- Models are downloaded explicitly via `parakeet install`, never on first transcription run
- If a model is missing, show a Playwright-style error directing the user to run install
- This is a deliberate design decision to avoid surprising multi-GB downloads

### BUN-ONLY RUNTIME

- This project runs on Bun, not Node.js. Use Bun-native APIs (`Bun.spawn`, `Bun.write`, `Bun.file`)
- TypeScript is executed directly by Bun — no build step
- The `ort-backend-fix.ts` workaround is required for onnxruntime-node CJS/ESM bridge under Bun

### EXTERNAL DEPENDENCY: ffmpeg

- ffmpeg must be in PATH for audio format conversion
- All audio is converted to 16kHz mono Float32 PCM internally

## Build Commands

```bash
# Install dependencies
bun install

# Run CLI
bun run src/cli.ts <audio_file>
bun run src/cli.ts install
bun run src/cli.ts --version

# Tests
bun test                              # All tests
bun run test:unit                     # Unit tests only (src/__tests__/)
bun run test:integration              # Integration tests (tests/integration/)

# Type check
bunx tsc --noEmit
```

## Project Structure

```
parakeet-cli/
├── bin/
│   └── parakeet.js               # Shebang entry point
├── src/
│   ├── cli.ts                    # CLI argument parsing, install/transcribe commands
│   ├── lib.ts                    # Public API (transcribe, downloadModel)
│   ├── transcribe.ts             # Orchestrates the full inference pipeline
│   ├── models.ts                 # Model download, cache check, requireModel
│   ├── audio.ts                  # ffmpeg-based audio conversion to Float32 PCM
│   ├── preprocess.ts             # Mel-spectrogram extraction (nemo128.onnx)
│   ├── encoder.ts                # FastConformer encoder (encoder-model.onnx)
│   ├── decoder.ts                # RNN-T joint decoder + beam search (decoder_joint-model.onnx)
│   ├── tokenizer.ts              # Vocab loading and detokenization
│   ├── ort-backend-fix.ts        # Bun CJS/ESM workaround for onnxruntime-node
│   └── __tests__/                # Unit tests
├── tests/
│   └── integration/              # E2E CLI tests
├── docs/
│   └── superpowers/specs/        # Design documents
└── package.json
```

## Architecture Overview

### Inference Pipeline

```
Audio file (any format)
  → [audio.ts] ffmpeg → Float32Array (16kHz mono)
  → [preprocess.ts] nemo128.onnx → Mel-spectrogram [1, 128, T]
  → [encoder.ts] encoder-model.onnx → Encoded features [1, D, T]
  → [decoder.ts] decoder_joint-model.onnx → Token IDs (beam search)
  → [tokenizer.ts] vocab.txt → Transcript text
```

### Model Files (ONNX backend, `~/.cache/parakeet/v3/`)

| File | Purpose |
|------|---------|
| `nemo128.onnx` | Audio preprocessor (waveform → 128-dim mel-spectrogram) |
| `encoder-model.onnx` | FastConformer encoder |
| `encoder-model.onnx.data` | Encoder weights (external data) |
| `decoder_joint-model.onnx` | RNN-T joint decoder |
| `vocab.txt` | Token vocabulary |

### Key Constants

- Decoder: 2 RNN layers, 640 hidden units
- Beam width: 4 (default)
- Min audio: 0.1s (1600 samples at 16kHz)
- Model source: `istupakov/parakeet-tdt-0.6b-v3-onnx` on HuggingFace

### Public API (`./core` export)

```typescript
import { transcribe, downloadModel } from "@drakulavich/parakeet-cli/core";

const text = await transcribe("audio.wav", { modelDir?, beamWidth? });
await downloadModel(noCache?, modelDir?);
```

## Code Style

- **TypeScript**: Strict mode, ESNext target
- **No build step**: Bun runs `.ts` directly
- **Imports**: Use relative paths (`./models`, not `src/models`)
- **Error output**: Use `console.error()` for progress/errors, `process.stdout.write()` for results
- **ONNX tensors**: Always use `.slice()` not `.subarray()` — Bun doesn't support subarray views as ONNX tensor data

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
- Runs on push/PR to main
- Type check (`bunx tsc --noEmit`)
- Unit tests (`bun run test:unit`)

## Platform Requirements

- **Runtime**: Bun >= 1.3.0
- **System**: ffmpeg in PATH
- **Supported**: macOS, Linux (anywhere Bun + onnxruntime-node runs)
