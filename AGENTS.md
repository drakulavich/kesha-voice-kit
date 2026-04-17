# Kesha Voice Kit — Agent Development Guide

> Authoritative reference: **[CLAUDE.md](./CLAUDE.md)**. This file is a shorter,
> editor-agnostic summary. When they disagree, CLAUDE.md wins.

## Build & Test

```bash
bun install          # Install dependencies
make test            # Unit + integration tests
make lint            # Type check
make smoke-test      # Link + install + run against fixtures
make release         # lint + test + smoke-test
```

## Architecture

- **src/cli.ts** — Bun CLI: argument parsing, `--format transcript|json`, install/transcribe/status
- **src/engine-install.ts** — Downloads engine from GitHub release matching `package.json#keshaEngine.version` (falls back to `package.json#version`)
- **src/engine.ts** — Subprocess wrapper + `getEngineCapabilities`
- **rust/** — `kesha-engine` Rust binary (ASR + lang-id)
  - `backend/{onnx,fluidaudio}.rs` — feature-gated ASR backends behind `TranscribeBackend` trait
  - `lang_id.rs` — ONNX speechbrain (always compiled; `ort`/`ndarray` are unconditional deps)
  - `build.rs` — Swift rpath under `#[cfg(feature = "coreml")]`
- **openclaw-plugin.cjs** — OpenClaw plugin (registers `MediaUnderstandingProvider`; actual transcription uses `type: "cli"` config path)

## Critical Rules

- **NEVER** auto-download engine or models — `kesha install` only
- **NEVER** use Node.js APIs — Bun-only (`Bun.spawn`, `Bun.write`, `Bun.file`)
- **NEVER** push directly to `main` — PRs only
- **NEVER** forward CLI flags blindly to `kesha-engine` — validate against `--capabilities-json`
- **BEFORE npm publish**: `make smoke-test`
- **BEFORE pushing TS**: `bun test && bunx tsc --noEmit`
- **BEFORE pushing Rust**: `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test` — `--all-targets` is required (catches dead code in tests too). Backend changes also need `cargo check --features coreml --no-default-features`
- **NEVER** add struct fields / enum variants "for later." Clippy `dead_code` is a hard error — delete the unused item or wire it up
- **Error handling**: human-readable messages (what, why, fix). Never swallow errors.

## Release Process

CLI and engine versions are **decoupled**. See CLAUDE.md for full rationale.

### CLI-only patch

```bash
# 1. Bump ONLY package.json#version
# 2. Verify
make smoke-test
# 3. PR, merge
# 4. Publish
npm publish --access public
# 5. Marker release (-cli suffix skips build-engine)
gh release create vX.Y.Z-cli --title "vX.Y.Z (CLI-only)" \
  --notes "Engine: v<keshaEngine.version> (unchanged)."
```

### Engine release

```bash
# 1. Bump rust/Cargo.toml + Cargo.lock + package.json#keshaEngine.version
# 2. PR, merge
# 3. Tag → build-engine → draft release
git tag vX.Y.Z && git push origin vX.Y.Z
# 4. Publish draft
gh release edit vX.Y.Z --draft=false
# 5. Verify + npm publish
make smoke-test && npm publish --access public
```

**Tag names are one-use** (immutable releases). Broken release → bump patch. Debug builds: `gh workflow run "🔨 Build Engine" --ref main`.

## OpenClaw Plugin

**How it actually works:** OpenClaw's `type: "cli"` audio runner spawns `kesha --format transcript {{MediaPath}}` and captures stdout. The `registerMediaUnderstandingProvider` path requires API keys (`requireApiKey()`) and silently fails for local CLI tools. The plugin registers a provider for discoverability only.

Recommended config:
```json
{"type":"cli","command":"kesha","args":["--format","transcript","{{MediaPath}}"],"timeoutSeconds":15}
```

**Scanner:** regex-based, comments count. Never name trigger tokens in `openclaw-plugin.cjs`. Split the module specifier across `+`. Use `--force` to overwrite stale installs. `configPatch` is NOT a valid manifest field.

## Code Style

- TypeScript: strict mode, ESNext, no build step
- Relative imports (`./engine`, not `src/engine`)
- `console.error()` for progress; `console.log()` for success (stdout = pipe-friendly)
- Rust: `cargo fmt` + `cargo clippy --all-targets -- -D warnings`
- Tests: `import { describe, test, expect } from "bun:test"`
