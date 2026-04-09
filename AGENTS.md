# parakeet-cli - Agent Development Guide

## Build & Test Commands

```bash
bun install                    # Install dependencies
make test                      # Unit + integration tests
make lint                      # Type check
make smoke-test                # Link + install + run against fixtures
make release                   # lint + test + smoke-test
make publish                   # release + npm publish
```

## Architecture

- **src/cli.ts**: CLI entry point — argument parsing, install/transcribe commands
- **src/lib.ts**: Public API — `transcribe`, `downloadModel`, `downloadCoreML`
- **src/transcribe.ts**: Backend selection — CoreML first, ONNX fallback
- **src/models.ts**: Thin re-export layer for `onnx-install` + `coreml-install`
- **src/onnx-install.ts**: ONNX model download, cache check, requireModel
- **src/coreml-install.ts**: CoreML binary + model download with capabilities handshake
- **src/coreml.ts**: CoreML backend — detection, subprocess invocation, wav retry
- **src/audio.ts**: ffmpeg-based audio conversion
- **src/benchmark-report.ts**: Benchmark markdown generation
- **src/preprocess.ts → encoder.ts → decoder.ts → tokenizer.ts**: ONNX inference pipeline
- **swift/**: Swift helper binary wrapping FluidAudio for CoreML transcription
- **scripts/**: Benchmark + smoke test scripts (TypeScript)
- **.github/scripts/**: CI helper scripts (TypeScript)
- **.github/actions/**: Composite actions (setup-bun, install-parakeet-backend)

## Critical Rules

- **NEVER** auto-download models — use `parakeet install`, show error if missing
- **NEVER** use Node.js APIs — this is Bun-only (`Bun.spawn`, `Bun.write`, `Bun.file`, `Bun.which`)
- **NEVER** use `.subarray()` for ONNX tensors — use `.slice()` (Bun limitation)
- **NEVER** push directly to `main` — it is a protected branch
- All changes must go through pull requests: create a feature branch, push, open a PR
- Create a **new PR for each distinct user request** — do not pile unrelated changes into one PR
- **NEVER** run `git push` unless explicitly requested by user
- Add unit tests when writing new code
- ffmpeg must be in PATH for ONNX backend audio conversion
- **NEVER** write more than 3 lines of bash in GitHub Actions workflow steps — extract to `.github/scripts/`
- **BEFORE npm publish**: run `make smoke-test` locally and verify all tests pass. Do NOT publish if smoke tests fail.
- **BEFORE pushing**: run `bun test && bunx tsc --noEmit` locally and verify all tests pass. Do NOT push broken code.
- **ALWAYS write proper error handling**: errors must be human-readable with context (what failed, why, what to do). Never swallow errors silently. Never let a function return success when it failed.

## Release Process

```bash
# 1. Bump version in package.json via PR, merge
# 2. Verify locally
make release
# 3. Tag and push — CI builds binary + creates GitHub release
git tag v0.8.0 && git push --tags
# 4. Publish to npm after CI passes
npm publish --access public
```

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
- `console.error()` for progress/errors, `console.log()` for success messages
- Follow existing patterns in the codebase
- Tests use `import { describe, test, expect } from "bun:test"`

## Dual Backend Design

- **CoreML** (macOS arm64): Pre-built Swift binary at `~/.cache/parakeet/coreml/bin/parakeet-coreml`, invoked as subprocess
- **ONNX** (cross-platform): Model files at `~/.cache/parakeet/v3/`, run in-process via onnxruntime-node
- `parakeet install` auto-detects platform: CoreML on macOS arm64, ONNX elsewhere
- CoreML install: downloads binary + model files (via `--download-only` flag)
- Override with `--coreml` or `--onnx` flags
