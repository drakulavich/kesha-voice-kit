# parakeet-cli - Agent Development Guide

## Build & Test Commands

```bash
bun install                                    # Install dependencies
bun test                                       # Run all tests
bun run test:unit                              # Unit tests only (src/__tests__/)
bun run test:integration                       # Integration tests (tests/integration/)
bunx tsc --noEmit                              # Type check
bun run src/cli.ts <audio_file>                # Run CLI
bun run src/cli.ts install                     # Download backend
bun run src/cli.ts --version                   # Show version
```

## Architecture

- **src/cli.ts**: CLI entry point — argument parsing, install/transcribe commands
- **src/lib.ts**: Public API — `transcribe`, `downloadModel`, `downloadCoreML`
- **src/transcribe.ts**: Backend selection — CoreML first, ONNX fallback
- **src/coreml.ts**: CoreML backend — platform detection, subprocess invocation
- **src/models.ts**: Model/binary download, cache management
- **src/audio.ts → preprocess.ts → encoder.ts → decoder.ts → tokenizer.ts**: ONNX inference pipeline
- **swift/**: Swift helper binary wrapping FluidAudio for CoreML transcription
- **Processing Pipeline**: Audio → (CoreML subprocess | ONNX pipeline) → Transcript text

## Critical Rules

- **NEVER** auto-download models — use `parakeet install`, show error if missing
- **NEVER** use Node.js APIs — this is Bun-only (`Bun.spawn`, `Bun.write`, `Bun.file`)
- **NEVER** use `.subarray()` for ONNX tensors — use `.slice()` (Bun limitation)
- **NEVER** push directly to `main` — it is a protected branch
- All changes must go through pull requests: create a feature branch, push, open a PR
- **NEVER** run `git push` unless explicitly requested by user
- Add unit tests when writing new code
- ffmpeg must be in PATH for ONNX backend audio conversion
- **NEVER** write more than 3 lines of bash in GitHub Actions workflow steps — extract to `.github/scripts/`

## Git Worktrees for Big Changes

For multi-file features or refactors, use git worktrees to work in isolation:

```bash
git worktree add ../parakeet-cli-feature feature/my-feature
cd ../parakeet-cli-feature
# work, commit, push, open PR
# when done:
cd ../parakeet-cli
git worktree remove ../parakeet-cli-feature
```

Use worktrees when:
- The change touches 5+ files
- You need to keep main clean while iterating
- Running long tasks (benchmarks, builds) without blocking the main checkout

## Code Style

- TypeScript strict mode, ESNext target
- No build step — Bun runs `.ts` directly
- Relative imports (`./models`, not `src/models`)
- `console.error()` for progress/errors, `process.stdout.write()` for results
- Follow existing patterns in the codebase
- Tests use `import { describe, test, expect } from "bun:test"`

## Dual Backend Design

- **CoreML** (macOS arm64): Pre-built Swift binary at `~/.cache/parakeet/coreml/bin/parakeet-coreml`, invoked as subprocess
- **ONNX** (cross-platform): Model files at `~/.cache/parakeet/v3/`, run in-process via onnxruntime-node
- `parakeet install` auto-detects platform: CoreML on macOS arm64, ONNX elsewhere
- Override with `--coreml` or `--onnx` flags
