# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Parakeet CLI is a fast multilingual speech-to-text tool powered by NVIDIA Parakeet TDT 0.6B models. It runs entirely locally with no cloud dependencies. Two backends: CoreML on macOS Apple Silicon (~155x real-time via FluidAudio), ONNX on all platforms (via onnxruntime-node). Built on Bun runtime.

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

### RELEASE PROCESS

- Before `npm publish`, always ask the user to run e2e tests locally first
- Suggest: `make smoke-test`
- Do NOT publish to npm without explicit user confirmation that tests pass
- Tag and push (`git tag vX.Y.Z && git push --tags`) — CI creates the GitHub release with CoreML binary
- Wait for CI to pass, then `npm publish --access public`

### VERIFY BEFORE PUSHING

- Run `bun test && bunx tsc --noEmit` locally before every push
- Do NOT push broken code — fix locally first

### ERROR HANDLING

- Always write proper error handling with human-readable messages
- Include context: what failed, why, and what to do about it
- Never swallow errors silently or let functions return success when they failed

### BRANCH PROTECTION

- `main` branch is protected — never push directly to main
- All changes must go through pull requests
- Create a feature branch, push it, and open a PR
- CI must pass before merging

### GIT WORKTREES FOR BIG CHANGES

- Use `git worktree add` for multi-file features or refactors
- Keeps main checkout clean while iterating on a feature branch
- Use when the change touches 5+ files or runs long tasks

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
│   ├── lib.ts                    # Public API (transcribe, downloadModel, downloadCoreML)
│   ├── transcribe.ts             # Backend selection: CoreML first, ONNX fallback
│   ├── coreml.ts                 # CoreML backend: detection, subprocess invocation
│   ├── models.ts                 # Model/binary download, cache check, requireModel
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

### Backend Selection

```
transcribe(audioPath)
  ├── CoreML installed? → spawn parakeet-coreml subprocess → stdout
  ├── ONNX cached?     → existing ONNX pipeline
  └── Neither?         → error: run "parakeet install"
```

### CoreML Backend (macOS Apple Silicon)

A pre-built Swift binary (`~/.cache/parakeet/coreml/bin/parakeet-coreml`) wraps [FluidAudio](https://github.com/FluidInference/FluidAudio) for CoreML inference on Apple Neural Engine. Invoked as a subprocess. CoreML model files are managed by FluidAudio internally.

### ONNX Backend (cross-platform)

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
import { transcribe, downloadModel, downloadCoreML } from "@drakulavich/parakeet-cli/core";

const text = await transcribe("audio.wav", { modelDir?, beamWidth? });
await downloadModel(noCache?, modelDir?);  // ONNX models
await downloadCoreML(noCache?);            // CoreML binary
```

## Code Style

- **TypeScript**: Strict mode, ESNext target
- **No build step**: Bun runs `.ts` directly
- **Imports**: Use relative paths (`./models`, not `src/models`)
- **Error output**: Use `console.error()` for progress/errors, `process.stdout.write()` for results
- **ONNX tensors**: Always use `.slice()` not `.subarray()` — Bun doesn't support subarray views as ONNX tensor data

## CI/CD

### WORKFLOW RULE: No inline scripts > 3 lines

- GitHub Actions workflow steps must not contain more than 3 lines of bash
- Extract longer logic into scripts under `.github/scripts/`
- Keep workflows declarative — scripts handle the logic

### Workflows

GitHub Actions:
- `.github/workflows/ci.yml` — runs on push/PR to main, matrix: ubuntu, windows, macos. Type check + unit tests.
- `.github/workflows/build-coreml.yml` — builds Swift binary on release publish, attaches to GitHub release as `parakeet-coreml-darwin-arm64`.

## Swift Binary (`swift/`)

A minimal Swift package wrapping FluidAudio. Built by CI, not by end users.
- `swift/Package.swift` — depends on FluidAudio >= 0.13.6
- `swift/Sources/ParakeetCoreML/main.swift` — reads audio, transcribes, prints to stdout

## Platform Requirements

- **Runtime**: Bun >= 1.3.0
- **System**: ffmpeg in PATH (ONNX backend only; CoreML handles conversion internally)
- **CoreML backend**: macOS 14+, Apple Silicon (arm64)
- **ONNX backend**: macOS, Linux, Windows (anywhere Bun + onnxruntime-node runs)
