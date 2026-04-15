# Kesha Voice Kit — Agent Development Guide

> The authoritative reference for engineering rules, architecture, and release
> workflow is **[CLAUDE.md](./CLAUDE.md)**. This file keeps a shorter,
> editor-agnostic summary. When they disagree, CLAUDE.md wins.

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

- **src/cli.ts** — Bun CLI entry: argument parsing, install/transcribe/status commands
- **src/lib.ts** — Public API exposed at `@drakulavich/kesha-voice-kit/core`
- **src/engine.ts** — Wrapper for spawning the `kesha-engine` Rust subprocess + `getEngineCapabilities`
- **src/engine-install.ts** — Downloads the engine binary from the GitHub release matching the current `package.json` version
- **src/transcribe.ts** — Thin forwarder to the engine
- **rust/** — `kesha-engine` Rust binary (ASR + lang-id), single source of truth for inference
  - `rust/src/main.rs` — clap subcommands: `transcribe`, `detect-lang`, `detect-text-lang`, `install`, `--capabilities-json`
  - `rust/src/backend/{onnx,fluidaudio}.rs` — feature-gated ASR backends behind a single trait
  - `rust/src/lang_id.rs` — ONNX speechbrain, always compiled regardless of feature
  - `rust/build.rs` — emits the Swift rpath under `#[cfg(feature = "coreml")]`
- **scripts/** — Benchmark + smoke-test TypeScript scripts
- **.github/workflows/** — `ci.yml`, `rust-test.yml`, `build-engine.yml`, `benchmark.yml`

## Critical Rules

- **NEVER** auto-download the engine or models — use `kesha install`, show an actionable error if missing
- **NEVER** use Node.js APIs in the CLI — it is Bun-only (`Bun.spawn`, `Bun.write`, `Bun.file`, `Bun.which`)
- **NEVER** push directly to `main` — it is a protected branch; all changes go through PRs
- **NEVER** run `git push` unless explicitly requested by the user
- **NEVER** blindly forward CLI flags to `kesha-engine` subcommands — validate against `--capabilities-json` instead. `kesha-engine install` accepts only `--no-cache`.
- Create a **new PR for each distinct user request** — do not pile unrelated changes into one PR
- **NEVER** write more than 3 lines of bash in GitHub Actions workflow steps — extract to `.github/scripts/`
- **BEFORE `npm publish`**: run `make smoke-test` against the freshly downloaded engine binary. Do NOT publish if smoke tests fail.
- **BEFORE pushing TS changes**: run `bun test && bunx tsc --noEmit`
- **BEFORE pushing Rust changes**: run `cd rust && cargo fmt && cargo clippy -- -D warnings && cargo test` — and if you touched `rust/src/backend/**` or `rust/Cargo.toml`, also run `cargo check --features coreml --no-default-features`
- **ALWAYS write proper error handling**: human-readable messages with context (what failed, why, what to do). Never swallow errors silently.
- Add unit tests when writing new code

## Release Process

The npm package version and the Rust engine version are **decoupled**.
`src/engine-install.ts` downloads the engine from the GitHub release tagged
`v${package.json#keshaEngine.version}` (falling back to `package.json#version`).
This split exists so CLI-only patches don't require a new engine release —
the previous coupling caused every release-bump PR's integration tests to 404
until the matching GitHub release existed.

### CLI-only patch (docs, TS bug fix, plugin manifest tweak, …)

```bash
# 1. Bump ONLY package.json#version. Leave keshaEngine.version and
#    rust/Cargo.toml at the current engine version.
# 2. Verify locally
make smoke-test
# 3. Open PR, merge. No Rust rebuild needed.
# 4. Publish
npm publish --access public
# 5. Cut a CLI-only marker release on GitHub. The -cli suffix is
#    excluded from build-engine.yml's tag filter, so pushing the tag
#    does NOT trigger a Rust rebuild or a conflicting release job.
gh release create vX.Y.Z-cli \
  --title "vX.Y.Z (CLI-only patch)" \
  --notes "CLI-only release. Engine binary: v<keshaEngine.version> (unchanged)."
```

### Engine release (anything under rust/, or a coreml/onnx change)

```bash
# 1. Bump all three in lockstep:
#      rust/Cargo.toml#version
#      rust/Cargo.lock           (via cd rust && cargo check)
#      package.json#keshaEngine.version
#    Usually also bump package.json#version to match.
# 2. PR, merge to main.
# 3. Tag and push — build-engine.yml builds all 3 binaries,
#    smoke-tests each with --capabilities-json, and creates a draft release.
git tag vX.Y.Z && git push origin vX.Y.Z
# 4. Verify the draft, then publish.
gh release edit vX.Y.Z --draft=false
# 5. Verify the new binary locally.
make smoke-test
# 6. Ship to npm.
npm publish --access public
```

### Tag names are one-use

GitHub's immutable releases feature permanently reserves a tag as soon as a
release publishes. **If a release goes out broken, you cannot reuse its tag —
bump the patch version instead.** v1.0.1 was skipped for exactly this reason.

### Debugging the build-engine workflow without tagging

`build-engine.yml` accepts `workflow_dispatch`. Run `gh workflow run "🔨 Build
Engine" --ref main` to build + smoke-test all three platforms without creating
a release — the release job is gated on `startsWith(github.ref, 'refs/tags/v')`.

## OpenClaw Plugin — Gotchas

The plugin lives in `openclaw.plugin.json` + `openclaw-plugin.cjs` (+ the
`openclaw.extensions` entry in `package.json`). Full rules in CLAUDE.md; the
non-obvious ones:

- **The skill scanner is regex-only and reads comments.** OpenClaw's
  `dangerous-exec` rule fires when a file contains both a `spawn(`/`exec(`-
  style call **and** the forbidden module-name substring anywhere in the
  file. Comments count. Never name the trigger tokens in
  `openclaw-plugin.cjs` — not in docs, not in backtick-quoted examples,
  nowhere. The only place any of them may appear is the actual call site.
- **Split the module specifier** across `+` so the forbidden substring is
  absent from the file source. This is the sanctioned bypass for a
  legitimate local-CLI wrapper.
- **`configPatch` is NOT a real manifest field.** Unknown top-level keys
  are silently discarded. Register providers at runtime from
  `openclaw-plugin.cjs`'s `register(api)` via
  `api.registerMediaUnderstandingProvider(...)`.
- **Manifest schema**: `id` and a proper JSON Schema `configSchema` are
  required. The `id` in the manifest must match the `id` passed to
  `registerMediaUnderstandingProvider`. Both are `kesha-voice-kit`.
- **`transcribeAudio(req)` takes `{ buffer: Buffer, fileName, timeoutMs, … }`** —
  not a file path. Write the buffer to a temp file, spawn `kesha --json`,
  parse JSON, clean up in `finally`.
- **Stale extension dirs survive failed installs.** If
  `openclaw plugins install` complains with `plugin already exists`,
  `rm -rf ~/.openclaw/extensions/kesha-voice-kit` and retry.
  `openclaw plugins uninstall` is interactive — no `--yes` flag.
- **Plugin changes are CLI-only patches.** Bump `package.json#version`
  only, leave `keshaEngine.version` alone, no git tag, just `npm publish`.

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
