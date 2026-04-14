# Unified Rust Inference Engine

**Date**: 2026-04-14
**Status**: Approved
**Scope**: New Rust project, TypeScript simplification, CI/CD, model management

## Problem

Parakeet CLI has three separate inference backends with different tech stacks:
1. **CoreML (Swift)** — `swift/` directory, FluidAudio, built by CI, subprocess
2. **ONNX (Node.js)** — `onnxruntime-node` npm package, CJS/ESM bridge hack (`ort-backend-fix.ts`), in-process
3. **Lang-ID (Node.js)** — `onnxruntime-node` for ECAPA-TDNN, same hack

This creates: a fragile `ort-backend-fix.ts` workaround, heavy `onnxruntime-node` dependency (~50MB), mandatory `ffmpeg` for ONNX users, two codebases (Swift + TypeScript) doing inference, and complex conditional logic in the TypeScript layer.

## Solution

Replace all three backends with a single Rust binary (`parakeet-engine`) that handles all inference. On macOS arm64, it uses `fluidaudio-rs` (CoreML/ANE). On Linux/Windows, it uses `ort` (ONNX Runtime CPU). TypeScript becomes a thin CLI shell that calls the binary as a subprocess.

## Constraints

- CLI interface unchanged for users (`parakeet <audio>`, `--json`, `--verbose`, `--lang`)
- Public API unchanged (`transcribe()` from `./core`)
- Pre-built binaries delivered via GitHub Releases, downloaded by `parakeet install`
- No ffmpeg dependency for users (Rust handles audio decoding)
- Version bump to 1.0.0

## Rust Project Structure

```
rust/
├── Cargo.toml
├── src/
│   ├── main.rs           # CLI entry point, subcommand routing
│   ├── transcribe.rs     # ASR pipeline (delegates to backend)
│   ├── lang_id.rs        # Audio lang-id (ECAPA-TDNN via ort)
│   ├── text_lang.rs      # Text lang-id (NLLanguageRecognizer on macOS via objc2, skip elsewhere)
│   ├── models.rs         # Model download & cache management
│   ├── audio.rs          # Audio loading/resampling (symphonia + rubato)
│   └── backend/
│       ├── mod.rs         # Backend trait
│       ├── fluidaudio.rs  # macOS: fluidaudio-rs (CoreML/ANE)
│       └── onnx.rs        # Linux/Windows: ort (ONNX Runtime CPU)
```

### Cargo Features

```toml
[features]
default = ["onnx"]
coreml = ["fluidaudio-rs"]  # macOS arm64 builds
onnx = ["ort"]              # all other platforms
```

### Key Dependencies

| Crate | Purpose |
|---|---|
| `fluidaudio-rs` | CoreML inference on macOS (ASR) |
| `ort` | ONNX Runtime inference on Linux/Windows (ASR + lang-id) |
| `symphonia` | Audio decoding (MP3, OGG, FLAC, WAV, AAC, Opus) |
| `rubato` | Audio resampling to 16kHz mono |
| `clap` | CLI argument parsing |
| `serde_json` | JSON output |
| `objc2` | NLLanguageRecognizer on macOS (text lang-id) |

### Supported Audio Formats (via symphonia)

WAV, MP3, OGG/Vorbis, FLAC, AAC/M4A, Opus. Covers 99% of use cases. WMA and AMR not supported (rare formats).

## CLI Interface (Rust Binary)

```
parakeet-engine transcribe <audio-path>
  → stdout: transcript text
  → stderr: progress/errors
  → exit 0 on success, 1 on error

parakeet-engine detect-lang <audio-path>
  → stdout: {"code":"ru","confidence":0.94}

parakeet-engine detect-text-lang <text>
  → stdout: {"code":"ru","confidence":0.98}
  (macOS only — uses NLLanguageRecognizer; other platforms exit 1)

parakeet-engine install [--no-cache]
  → downloads models to ~/.cache/parakeet/
  → stderr: progress

parakeet-engine --capabilities-json
  → stdout: {"protocolVersion":2,"backend":"coreml"|"onnx","features":["transcribe","detect-lang","detect-text-lang"]}
```

Protocol version 2 distinguishes from the old Swift binary. TypeScript checks version and feature list.

## TypeScript Side Changes

### Remove

| File | Reason |
|---|---|
| `onnxruntime-node` dependency | Replaced by Rust `ort` |
| `src/ort-backend-fix.ts` | No longer needed |
| `src/preprocess.ts` | ONNX pipeline moved to Rust |
| `src/encoder.ts` | ONNX pipeline moved to Rust |
| `src/decoder.ts` | ONNX pipeline moved to Rust |
| `src/tokenizer.ts` | ONNX pipeline moved to Rust |
| `src/audio.ts` | Audio handling moved to Rust (symphonia) |
| `swift/` directory | Replaced by Rust |

### Simplify

| File | Change |
|---|---|
| `src/transcribe.ts` | Thin wrapper: call `parakeet-engine transcribe`, return stdout |
| `src/coreml.ts` → `src/engine.ts` | Generic subprocess interface to `parakeet-engine` |
| `src/coreml-install.ts` → `src/engine-install.ts` | Download platform-specific binary from GitHub Releases |
| `src/lang-id.ts` | Remove ONNX inference, call `parakeet-engine detect-lang` |
| `src/lang-id-install.ts` | Remove model download (engine manages its own models) |

### Keep Unchanged

- `src/cli.ts` — CLI arg parsing, output formatting
- `src/log.ts`, `src/progress.ts`, `src/status.ts`
- `tinyld` — baseline text lang-id on all platforms

### Result

TypeScript becomes a thin CLI shell. No native Node addons, no ffmpeg dependency. The `package.json` dependencies shrink to: `citty`, `picocolors`, `tinyld`.

## Model Management

```
~/.cache/parakeet/
├── engine/
│   └── bin/
│       └── parakeet-engine          # the binary itself
├── models/
│   ├── parakeet-tdt-v3/             # ASR models (onnx backend only)
│   │   ├── encoder-model.onnx
│   │   ├── decoder_joint-model.onnx
│   │   ├── nemo128.onnx
│   │   └── vocab.txt
│   └── lang-id-ecapa/               # Lang-ID model
│       ├── lang-id-ecapa.onnx
│       ├── lang-id-ecapa.onnx.data
│       └── labels.json
└── coreml/                           # CoreML models (macOS only, managed by FluidAudio)
    └── models-v3-installed           # marker file
```

- macOS with `fluidaudio-rs`: FluidAudio downloads/compiles its own CoreML models. ONNX models in `models/` not needed.
- Linux/Windows with `ort`: ONNX models in `models/` used. No CoreML directory.

### Install Flow

1. TypeScript: download `parakeet-engine` binary for platform → `~/.cache/parakeet/engine/bin/`
2. TypeScript: run `parakeet-engine install` → Rust binary downloads correct models for its backend

## CI and Release Pipeline

### Build workflow: `.github/workflows/build-engine.yml`

Triggered on tag push (`v*`). Builds 3 binaries in parallel:

| Job | Runner | Target | Features | Binary |
|---|---|---|---|---|
| macOS arm64 | `macos-14` | `aarch64-apple-darwin` | `coreml` | `parakeet-engine-darwin-arm64` |
| Linux x64 | `ubuntu-latest` | `x86_64-unknown-linux-gnu` | `onnx` | `parakeet-engine-linux-x64` |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` | `onnx` | `parakeet-engine-windows-x64.exe` |

All 3 binaries attached to the same GitHub Release. Replaces `build-coreml.yml`.

### Test workflow: `.github/workflows/rust-test.yml`

Runs `cargo test` on all 3 platforms for PRs.

### TypeScript download logic (engine-install.ts)

```
platform + arch → binary name:
  darwin + arm64  → parakeet-engine-darwin-arm64
  linux + x64     → parakeet-engine-linux-x64
  win32 + x64     → parakeet-engine-windows-x64.exe
```

## Migration and Backward Compatibility

### Unchanged for users

- CLI: `parakeet <audio>`, `--json`, `--verbose`, `--lang`
- Public API: `transcribe()` from `./core`
- Install: `parakeet install`
- Status: `parakeet status`

### What changes

- Users re-run `parakeet install` after upgrade (old binaries/models not used)
- `ffmpeg` no longer required
- `TranscribeOptions.modelDir` deprecated (engine manages its own models)
- Version bumped to `1.0.0`

### Legacy cleanup

During `parakeet install`, detect and remove old files:
- `~/.cache/parakeet/v3/` (old ONNX models)
- `~/.cache/parakeet/coreml/bin/parakeet-coreml` (old Swift binary)
- Print: "Cleaning up legacy backend files..."

## Out of Scope

- VAD (voice activity detection) — future feature
- Speaker diarization — future feature
- TTS — not planned
- macOS x64 support — Apple Silicon only for CoreML
- Linux arm64 — future if needed
