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

- This project runs on Bun, not Node.js. Use Bun-native APIs (`Bun.spawn`, `Bun.write`, `Bun.file`, `Bun.which`)
- TypeScript is executed directly by Bun — no build step
- The `ort-backend-fix.ts` workaround is required for onnxruntime-node CJS/ESM bridge under Bun

### EXTERNAL DEPENDENCY: ffmpeg

- ffmpeg must be in PATH for audio format conversion (ONNX backend only)
- Use `Bun.which("ffmpeg")` to check — not `which` command (cross-platform)

### RELEASE PROCESS

- Before `npm publish`, run `make smoke-test` locally and verify all tests pass
- Do NOT publish to npm if smoke tests fail
- Tag and push (`git tag vX.Y.Z && git push --tags`) — CI creates the GitHub release with CoreML binary
- Wait for CI to pass, then `npm publish --access public`

### VERIFY BEFORE PUSHING

- Run `bun test && bunx tsc --noEmit` locally before every push
- When changing Rust code (`rust/`), run `cd rust && cargo fmt` before every commit
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
bun install                    # Install dependencies
make test                      # Unit + integration tests
make lint                      # Type check
make smoke-test                # Link + install + run against fixtures
make release                   # lint + test + smoke-test
make publish                   # release + npm publish
make benchmark-coreml          # CoreML vs WhisperKit (local, macOS only)
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
│   ├── models.ts                 # Thin re-export layer (onnx-install + coreml-install)
│   ├── onnx-install.ts           # ONNX model download, cache check, requireModel
│   ├── coreml-install.ts         # CoreML binary + model download with capabilities handshake
│   ├── coreml.ts                 # CoreML backend: detection, subprocess invocation, wav retry
│   ├── audio.ts                  # ffmpeg-based audio conversion to Float32 PCM
│   ├── benchmark-report.ts       # Benchmark markdown report generation
│   ├── preprocess.ts             # Mel-spectrogram extraction (nemo128.onnx)
│   ├── encoder.ts                # FastConformer encoder (encoder-model.onnx)
│   ├── decoder.ts                # RNN-T joint decoder + beam search (decoder_joint-model.onnx)
│   ├── tokenizer.ts              # Vocab loading and detokenization
│   ├── ort-backend-fix.ts        # Bun CJS/ESM workaround for onnxruntime-node
│   └── __tests__/                # Unit tests
├── tests/
│   └── integration/              # E2E tests (require backend + ffmpeg)
├── scripts/
│   ├── benchmark.ts              # CI benchmark (faster-whisper vs parakeet)
│   ├── benchmark-coreml.ts       # Local CoreML benchmark (WhisperKit vs parakeet)
│   └── smoke-test.ts             # Pre-release fixture verification
├── .github/
│   ├── scripts/                  # CI helper scripts (TypeScript)
│   ├── actions/                  # Composite actions (setup-bun, install-parakeet-backend)
│   └── workflows/                # CI, benchmark, build-coreml
├── swift/                        # CoreML Swift binary (built by CI)
├── Makefile                      # Development commands
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

A pre-built Swift binary (`~/.cache/parakeet/coreml/bin/parakeet-coreml`) wraps [FluidAudio](https://github.com/FluidInference/FluidAudio) for CoreML inference on Apple Neural Engine. Invoked as a subprocess. `parakeet install` downloads both the binary and CoreML model files.

### ONNX Backend (cross-platform)

```
Audio file (any format)
  → [audio.ts] ffmpeg → Float32Array (16kHz mono)
  → [preprocess.ts] nemo128.onnx → Mel-spectrogram [1, 128, T]
  → [encoder.ts] encoder-model.onnx → Encoded features [1, D, T]
  → [decoder.ts] decoder_joint-model.onnx → Token IDs (beam search)
  → [tokenizer.ts] vocab.txt → Transcript text
```

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
await downloadCoreML(noCache?);            // CoreML binary + models
```

## Code Style

- **TypeScript**: Strict mode, ESNext target
- **No build step**: Bun runs `.ts` directly
- **Imports**: Use relative paths (`./models`, not `src/models`)
- **Progress/errors**: `console.error()` — **Success messages**: `console.log()`
- **ONNX tensors**: Always use `.slice()` not `.subarray()` — Bun doesn't support subarray views as ONNX tensor data

## CI/CD

### WORKFLOW RULE: No inline scripts > 3 lines

- GitHub Actions workflow steps must not contain more than 3 lines of bash
- Extract longer logic into scripts under `.github/scripts/`
- Keep workflows declarative — scripts handle the logic

### Workflows

- `.github/workflows/ci.yml` — runs on PRs to main. Unit tests (ubuntu/windows/macos) + integration tests (macos). Type check on ubuntu only.
- `.github/workflows/build-coreml.yml` — triggers on tag push (`v*`). Builds Swift binary, creates GitHub release with binary attached.
- `.github/workflows/benchmark.yml` — manual benchmark workflow. Runs faster-whisper vs parakeet on ubuntu and publishes results in the workflow summary and artifacts.

### Composite Actions

- `.github/actions/setup-bun/` — setup Bun with dependency caching
- `.github/actions/install-parakeet-backend/` — install backend with CoreML/ffmpeg caching

## Swift Binary (`swift/`)

A minimal Swift package wrapping FluidAudio. Built by CI on tag push, not by end users.
- `swift/Package.swift` — depends on FluidAudio
- `swift/Sources/ParakeetCoreML/main.swift` — supports `--download-only`, `--capabilities`, and audio transcription

## Platform Requirements

- **Runtime**: Bun >= 1.3.0
- **System**: ffmpeg in PATH (ONNX backend only; CoreML handles conversion internally)
- **CoreML backend**: macOS 14+, Apple Silicon (arm64)
- **ONNX backend**: macOS, Linux, Windows (anywhere Bun + onnxruntime-node runs)
- **TTS**: `espeak-ng` on PATH (`brew install espeak-ng` / `apt install espeak-ng` / `choco install espeak-ng`). Vendoring tracked in [#124](https://github.com/drakulavich/kesha-voice-kit/issues/124).

## TTS (M1+)

Text-to-speech via Kokoro-82M (English, M1). Opt-in via `kesha install --tts`.

- TTS models are **never auto-downloaded** — same rule as ASR. `kesha say` fails loudly with `kesha install --tts` hint when models are missing.
- `kesha say` writes WAV (24kHz mono f32) to stdout unless `--out` is given. Stderr = progress/errors only.
- G2P uses statically-linked `espeakng-sys` crate (dynamic-linked in M1 against system libespeak-ng). Phoneme mode `0x02` = IPA; not `0x02 << 4`.
- Kokoro ONNX interface: input_ids (int64 [1,N]), **style (f32 [1,256]) — rank-2, not rank-3**, speed (f32 [1]). Output tensor name is `"waveform"` (not `"audio"`). Voice file is **510 rows × 256 cols** (not 511).
- Use `KESHA_ENGINE_BIN` env var to override the default engine-binary path for development (e.g., point at `rust/target/release/kesha-engine` when iterating).
- Use `KESHA_CACHE_DIR` env var for an isolated test cache.
- macOS runtime needs `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` for dev builds; release binaries fix up via `install_name_tool`.
- macOS build needs `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib` and `RUSTFLAGS="-L /opt/homebrew/lib"`.

Russian (Silero) + auto-routing via `NLLanguageRecognizer` are M3. See `docs/superpowers/specs/2026-04-16-bidirectional-voice-design.md`.
