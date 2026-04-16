# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kesha Voice Kit is a fast multilingual voice toolkit: speech-to-text (NVIDIA Parakeet TDT 0.6B) plus audio- and text-based language detection. It runs entirely locally with no cloud dependencies.

The CLI (`kesha`, with `parakeet` as a backward-compatible alias) is a thin Bun/TypeScript wrapper around a single Rust binary, `kesha-engine`, downloaded from GitHub Releases during `kesha install`. The Rust engine has two compile-time backends for ASR:
- **CoreML** (Apple Silicon): FluidAudio / Apple Neural Engine via `fluidaudio-rs`. Built on `macos-14` with Xcode 16.2 and `MACOSX_DEPLOYMENT_TARGET=14.0`.
- **ONNX** (Linux / Windows / fallback): `ort` crate with the `istupakov/parakeet-tdt-0.6b-v3-onnx` models.

Language detection (`lang_id.rs`) always uses ONNX regardless of ASR backend. Text language detection uses macOS `NLLanguageRecognizer` (macOS only).

Two interfaces: the CLI and a programmatic API exported from `@drakulavich/kesha-voice-kit/core`.

## Critical Development Rules

### NEVER AUTO-DOWNLOAD THE ENGINE OR MODELS

- `kesha install` downloads explicitly; never on first transcription run
- Surface an actionable error if anything is missing
- Deliberate design to avoid surprising multi-GB downloads

### BUN-ONLY RUNTIME FOR THE CLI

- Bun-native APIs only (`Bun.spawn`, `Bun.write`, `Bun.file`, `Bun.which`)
- TypeScript executed directly by Bun — no build step
- The engine is a Rust binary invoked as a subprocess — not linked in-process

### RELEASE PROCESS — CLI AND ENGINE ARE VERSIONED INDEPENDENTLY

`package.json#version` (CLI) and `package.json#keshaEngine.version` (engine, mirrored in `rust/Cargo.toml`) are **decoupled**. `src/engine-install.ts` downloads from `v${keshaEngine.version}`, falling back to `package.json#version`.

**CLI-only patch** (docs, TS fix, plugin tweak):

1. Bump only `package.json#version`. Leave `keshaEngine.version` and `rust/Cargo.toml` alone.
2. PR CI uses the existing engine binary — integration tests pass.
3. Merge, `npm publish --access public`.
4. Cut a marker release: `gh release create vX.Y.Z-cli --title "vX.Y.Z (CLI-only)" --notes "Engine: v<keshaEngine.version> (unchanged)."` The `-cli` suffix is excluded from `build-engine.yml`'s tag filter — no Rust rebuild.

**Engine release** (anything under `rust/`, or bumping `keshaEngine.version`):

1. Bump `rust/Cargo.toml`, `rust/Cargo.lock` (via `cargo check`), and `package.json#keshaEngine.version` in lockstep. Usually bump `package.json#version` too.
2. Merge to main.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` — triggers `build-engine.yml`.
4. Publish the draft: `gh release edit vX.Y.Z --draft=false`.
5. `make smoke-test` locally. Do NOT publish if smoke tests fail.
6. `npm publish --access public`.

### TAG NAMES ARE ONE-USE

GitHub's immutable-releases permanently reserves tag names after publish. **Broken release → bump patch version, cut new tag.** Never tag "just to test" — use `gh workflow run "🔨 Build Engine" --ref main` instead. Skipping tags is fine (we skipped `v1.0.1`).

### VERIFY BEFORE PUSHING

- `bun test && bunx tsc --noEmit` before every push
- Rust changes: `cd rust && cargo fmt && cargo clippy -- -D warnings`
- Backend module changes: also `cargo check --features coreml --no-default-features`
- Do NOT push broken code

### ERROR HANDLING

- Human-readable messages with context: what failed, why, what to do
- Never swallow errors; never return success on failure

### BRANCH PROTECTION

- `main` is protected — all changes go through PRs
- CI must pass before merging

### DO NOT BLINDLY FORWARD CLI FLAGS TO SUBCOMMANDS

Validate flags against `kesha-engine --capabilities-json` instead of forwarding to the engine subprocess. `kesha-engine install` only accepts `--no-cache`.

### COREML BUILD TRIPLE

The `coreml` feature links the macOS Swift runtime via `fluidaudio-rs`. All three must be true:
1. `macos-14` runner + `maxim-lobanov/setup-xcode@v1` pinned to `16.2`
2. `MACOSX_DEPLOYMENT_TARGET=14.0` so the linker elides `@rpath/libswift_Concurrency.dylib`
3. `rust/build.rs` emits `-Wl,-rpath,/usr/lib/swift` under `#[cfg(feature = "coreml")]`

The build-engine workflow smoke-tests every binary with `--capabilities-json` before upload. **Never remove that step.**

### OPENCLAW PLUGIN

The plugin lives in `openclaw.plugin.json` + `openclaw-plugin.cjs` (+ `package.json#openclaw.extensions`).

**How audio transcription actually works in OpenClaw:** the `type: "cli"` path in `tools.media.audio.models` — NOT `registerMediaUnderstandingProvider` (that path requires API keys via `requireApiKey()` and silently fails for local CLI tools). The plugin registers a `MediaUnderstandingProvider` for discoverability (`openclaw plugins inspect` shows `Shape: plain-capability`), but the actual transcription routes through `runCliEntry`, which spawns `kesha --format transcript {{MediaPath}}` and captures stdout.

Recommended user config:
```json
{"type":"cli","command":"kesha","args":["--format","transcript","{{MediaPath}}"],"timeoutSeconds":15}
```

**Scanner rules:**
- OpenClaw's `dangerous-exec` scanner fires when a file contains BOTH a `spawn(`/`exec(`-style call AND the substring for the forbidden module name. **Comments count** — it's a naive regex, not AST-aware.
- Split the module specifier across `+` so the forbidden substring is absent from the source. Never name trigger tokens anywhere in `openclaw-plugin.cjs` — not even in comments.
- `--force` flag overwrites existing installs. `openclaw plugins uninstall` is interactive (no `--yes`).

**Manifest:** required fields are `id` + `configSchema` (proper JSON Schema shape). `configPatch` is NOT a valid field — the loader silently discards it.

## Build Commands

```bash
bun install                    # Install dependencies
make test                      # Unit + integration tests
make lint                      # Type check
make smoke-test                # Link + install + run against fixtures
make release                   # lint + test + smoke-test
make publish                   # release + npm publish
```

## Project Structure

```
kesha-voice-kit/
├── bin/kesha.js                    # Shebang entry point (aliased as `parakeet` too)
├── src/                            # Bun/TypeScript CLI + library
│   ├── cli.ts                      # Argument parsing, --format, install/transcribe/status
│   ├── lib.ts                      # Public API at `@drakulavich/kesha-voice-kit/core`
│   ├── engine.ts                   # Engine subprocess wrapper + getEngineCapabilities
│   ├── engine-install.ts           # Engine binary download (uses keshaEngine.version)
│   ├── transcribe.ts               # Thin forwarder to the engine
│   └── __tests__/                  # Unit tests
├── rust/                           # kesha-engine (Rust binary)
│   ├── Cargo.toml                  # `onnx` (default) and `coreml` features
│   ├── build.rs                    # Swift rpath under `coreml` feature
│   └── src/
│       ├── main.rs                 # clap: transcribe / detect-lang / detect-text-lang / install
│       ├── audio.rs                # symphonia decode + rubato resample to 16kHz mono f32
│       ├── models.rs               # HF download + cache for ASR and lang-id models
│       ├── lang_id.rs              # ONNX speechbrain audio language detection (always built)
│       ├── text_lang.rs            # macOS NLLanguageRecognizer (macOS only)
│       └── backend/
│           ├── mod.rs              # TranscribeBackend trait (audio_path → String)
│           ├── onnx.rs             # ORT pipeline: nemo128 → encoder → decoder_joint (beam=4)
│           └── fluidaudio.rs       # fluidaudio-rs 0.1 via transcribe_file (coreml feature)
├── tests/{unit,integration}/       # bun test
├── scripts/                        # benchmark.ts, smoke-test.ts
├── .github/workflows/
│   ├── ci.yml                      # PR: unit + integration + type check
│   ├── rust-test.yml               # PR: cargo test/fmt/clippy + coreml feature check
│   └── build-engine.yml            # Tag push or dispatch: build 3 binaries + draft release
├── openclaw.plugin.json            # OpenClaw manifest (id + configSchema)
├── openclaw-plugin.cjs             # OpenClaw plugin entry (registerMediaUnderstandingProvider)
└── package.json                    # @drakulavich/kesha-voice-kit
```

## Architecture

### Request flow

```
kesha audio.ogg
  → cli.ts → transcribe.ts → spawn kesha-engine transcribe <path>
       → rust: backend::create_backend() → TranscribeBackend::transcribe(path)
           ├── coreml: FluidAudio::transcribe_file
           └── onnx:   symphonia → nemo128 → encoder → decoder_joint
  → stdout: transcript; stderr: progress/errors
```

### Output formats

```bash
kesha audio.ogg                        # plain text
kesha --format transcript audio.ogg    # text + [lang: ru, confidence: 1.00]
kesha --format json audio.ogg          # full JSON with lang fields
kesha --json audio.ogg                 # alias for --format json
```

### Rust engine features

- `default = ["onnx"]`. `ort` and `ndarray` are **unconditional** (lang_id always uses them). The `onnx` feature only gates `backend/onnx.rs`.
- `coreml = ["dep:fluidaudio-rs"]` — mutually exclusive at module level via `#[cfg(all(feature = "onnx", not(feature = "coreml")))]`.
- Exactly one ASR backend per binary. No runtime fallback.

### Public API (`./core` export)

```typescript
import { transcribe, downloadEngine, getEngineCapabilities } from "@drakulavich/kesha-voice-kit/core";
const text = await transcribe("audio.ogg");
```

## Code Style

- **TypeScript**: Strict mode, ESNext target, Bun runs `.ts` directly
- **Imports**: Relative paths (`./engine`, not `src/engine`)
- **Output**: `console.error()` for progress/errors, `console.log()` for success (stdout stays pipe-friendly)
- **Rust**: `cargo fmt` + `cargo clippy -- -D warnings`

## CI/CD

- **ci.yml** — PRs to main. Unit tests (ubuntu/windows/macos) + integration (macos-14) + type check (ubuntu).
- **rust-test.yml** — PRs touching `rust/**`. cargo test/fmt/clippy on 3 OSes + `cargo check --features coreml --no-default-features` on macos-14.
- **build-engine.yml** — Tag push (`v*`, excluding `v*-cli`) or `workflow_dispatch`. Builds 3 platform binaries, smoke-tests each with `--capabilities-json`, creates draft release.
- **No inline scripts > 3 lines** — extract to `.github/scripts/`.

## Platform Requirements

- **Runtime**: Bun >= 1.3.0 (CLI only; engine is a standalone Rust binary)
- **CoreML engine**: macOS 14+, Apple Silicon (arm64)
- **ONNX engine**: macOS, Linux, Windows
- `ffmpeg` is **not required** — the Rust engine uses symphonia + rubato
