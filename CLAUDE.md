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
4. **Write release notes before publishing.** `build-engine.yml` creates a draft with EMPTY body via `softprops/action-gh-release`. Author the notes now:
   ```bash
   gh release edit vX.Y.Z --notes "$(cat <<'EOF'
   <summary of changes, new features, breaking changes, PR list>
   EOF
   )"
   ```
   Use the v1.1.3 release as a template: features → platform support → breaking changes → shipped PRs → follow-up issues → upgrade instructions.

   **If you forgot and already published:** `gh release edit --notes` silently drops content on published releases (a `gh` CLI quirk — not a GitHub restriction). The `immutable: true` flag protects tag/assets, not the body. Escape hatch is a direct API PATCH:
   ```bash
   RELEASE_ID=$(gh api repos/OWNER/REPO/releases/tags/vX.Y.Z --jq '.id')
   jq -Rs '{body: .}' < notes.md > body.json
   gh api -X PATCH "repos/OWNER/REPO/releases/$RELEASE_ID" --input body.json
   ```
   v1.1.3 shipped with empty notes and was recovered this way.
5. Publish the draft: `gh release edit vX.Y.Z --draft=false`.
6. `make smoke-test` locally. Do NOT publish if smoke tests fail.
7. `npm publish --access public`.

### TAG NAMES ARE ONE-USE

GitHub's immutable-releases permanently reserves tag names after publish. **Broken release → bump patch version, cut new tag.** Never tag "just to test" — use `gh workflow run "🔨 Build Engine" --ref main` instead. Skipping tags is fine (we skipped `v1.0.1`).

### VERIFY BEFORE PUSHING

- `bun test && bunx tsc --noEmit` before every push
- Rust changes: `cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings`
  (`--all-targets` is required — otherwise test-only dead code escapes to CI)
- Backend module changes: also `cargo check --features coreml --no-default-features`
- Do NOT push broken code

**Why `--all-targets` matters:** CI's ubuntu job runs clippy; the macOS jobs run only `cargo test`. Without `--all-targets`, local clippy misses dead code in `#[cfg(test)]` blocks and tests — which then breaks CI after push. (Lesson: #125 M1 landed a dead enum variant + struct field that passed on macOS but failed ubuntu.)

### NO SPECULATIVE FIELDS OR ENUM VARIANTS

Don't add struct fields, enum variants, or constants "for later." Clippy's `dead_code` lint is a hard error under `-D warnings`, so any unused public item will fail CI.

- **Fix, don't suppress:** delete the unused item. Add `#[allow(dead_code)]` only with a justification in the comment.
- If something needs to exist but isn't wired up yet, wire it up OR leave a `todo!()` call that exercises the variant.

### ERROR HANDLING

- Human-readable messages with context: what failed, why, what to do
- Never swallow errors; never return success on failure

### BRANCH PROTECTION

- `main` is protected — all changes go through PRs
- CI must pass before merging

### VERIFY THIRD-PARTY MODEL FORMATS WITH A SPIKE

Any plan that names a specific upstream artifact ("Silero via ONNX", "statically-linked espeak-ng", "FluidAudio CoreML Kokoro") MUST be validated with a throwaway spike BEFORE the implementation phase commits to it.

- The spike downloads / builds the thing and runs it end-to-end — not just "checks if the repo exists."
- Past pivots this rule would have prevented earlier: espeak-ng turned out to be dynamic-link-only in `espeakng-sys` (→ pivoted to system-dep + issue #124); Silero TTS ships PyTorch-only and has no public ONNX export (→ pivoted to Piper in M3).
- Spike artifacts go in `/tmp/<name>-spike/` and are deleted after the finding is recorded in the plan doc.

### GREPTILE PR REVIEW IS A GATE

PRs receive automated review from Greptile (as a PR comment on each push). Treat P1/P2 findings as merge blockers — address them before marking the PR ready-for-review.

- Pattern: push → Greptile reviews → fix → push → merge.
- Past incidents caught this way: `--backend=` forwarded to an engine that didn't accept it (#125 P1); `--rate` silently discarded for Piper voices (#126 P1); hard-coded 22050 Hz assertion that would break on other Piper voices (#126 P2).
- Exception: findings that are clearly false positives can be dismissed with a PR comment explaining why — but that's rare in practice.

### DO NOT BLINDLY FORWARD CLI FLAGS TO SUBCOMMANDS

Validate flags against `kesha-engine --capabilities-json` instead of forwarding to the engine subprocess. `kesha-engine install` only accepts `--no-cache`.

### COREML BUILD TRIPLE

The `coreml` feature links the macOS Swift runtime via `fluidaudio-rs`. All three must be true:
1. `macos-14` runner + `maxim-lobanov/setup-xcode@v1` pinned to `16.2`
2. `MACOSX_DEPLOYMENT_TARGET=14.0` so the linker elides `@rpath/libswift_Concurrency.dylib`
3. `rust/build.rs` emits `-Wl,-rpath,/usr/lib/swift` under `#[cfg(feature = "coreml")]`

The build-engine workflow smoke-tests every binary with `--capabilities-json` before upload. **Never remove that step.**

### BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS

`build-engine.yml` passes `--features ${{ matrix.features }} --no-default-features` per platform. When you add a new cargo feature to the default set (e.g. `tts` in M3), **you must also add it to each matrix row** in build-engine.yml — otherwise the released binaries silently ship without that feature even though the source tree at that tag supports it.

Past incident: v1.1.0 shipped engine binaries with only `coreml` or `onnx`, omitting `tts`. `kesha say` was missing from released binaries; users were broken. Fixed in v1.1.3 by adding `coreml,tts` / `onnx,tts` to the matrix.

Check before cutting a release: `diff <(grep 'features = ' .github/workflows/build-engine.yml) <(grep default rust/Cargo.toml)` — make sure every default feature appears in every matrix row.

### BINDGEN ON LINUX NEEDS LIBCLANG_PATH

Any Rust crate using `bindgen` (directly or transitively — e.g. `espeakng-sys` with `clang-runtime` feature) needs `LIBCLANG_PATH` on Linux build runners even with `apt install libclang-dev`. The `clang-runtime` feature makes bindgen `dlopen` libclang at build-script runtime; the apt package installs into a versioned subdir that isn't on the default dlopen path.

Portable recipe for the Linux job:
```yaml
- run: |
    sudo apt-get install -y libclang-dev llvm-dev
    echo "LIBCLANG_PATH=$(llvm-config --libdir)" >> $GITHUB_ENV
```

macOS equivalent is `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib`. Windows: pending, part of the broader Windows-TTS deferral.

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
- **Rust**: `cargo fmt` + `cargo clippy --all-targets -- -D warnings`

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
- **TTS**: `espeak-ng` on PATH (`brew install espeak-ng` / `apt install espeak-ng` / `choco install espeak-ng`). Vendoring tracked in [#124](https://github.com/drakulavich/kesha-voice-kit/issues/124).

## TTS

Text-to-speech via three engines selected by voice id prefix:

- `en-*` → **Kokoro-82M**. Separate model + per-voice style embedding. Output 24 kHz.
- `ru-*` → **Piper VITS** (`rhasspy/piper-voices`). Per-voice `.onnx` + `.onnx.json`. Output depends on voice (22.05 kHz for medium tier).
- `macos-*` → **AVSpeechSynthesizer** via a Swift sidecar (#141, opt-in `--features system_tts` for now). Zero model download, notification-grade quality. Release integration is Part 3.

Opt-in via `kesha install --tts` (downloads Kokoro + Piper, ~390 MB). `macos-*` voices need no install — they use voices already on macOS.

- TTS models are **never auto-downloaded** — `kesha say` fails loudly with a `kesha install --tts` hint when models are missing.
- `kesha say` writes WAV mono f32 to stdout unless `--out` is given. Stderr is progress/errors only.
- G2P uses `espeakng-sys` (dynamic link against system `libespeak-ng`) for both engines.
- **Auto-routing:** when `--voice` is omitted, the TS CLI calls `NLLanguageRecognizer` on the input text and picks `en-af_heart` or `ru-denis`. Confidence < 0.5 or unmapped language falls through to the engine default. `pickVoiceForLang` in `src/cli.ts` is the routing table — add a language by adding a match arm.
- **SSML** (opt-in via `--ssml`): uses the `ssml-parser` crate; supports `<speak>` root and `<break time="...">` for silence. Unknown tags (`<emphasis>`, `<prosody>`, `<phoneme>`, `<say-as>`) warn to stderr once per name and are stripped, but contained text is still synthesized. Hardening: required `<speak>` root, `<!DOCTYPE>` rejected anywhere in input. `tts::ssml::parse` returns `Vec<Segment>`; `tts::say()` loads the engine once and concatenates f32 samples for text vs silence for breaks before a single `wav::encode_wav`. See issue #122 for the full scope matrix and future tag support.
- Kokoro ONNX: `input_ids` (int64 `[1,N]`), `style` (f32 `[1,256]` — rank-2), `speed` (f32 `[1]`). Output name `"waveform"`. Voice file 510 rows × 256 cols.
- Piper ONNX: `input` (int64 `[1,N]` — BOS + pad-interleaved phoneme IDs + EOS), `input_lengths` (int64 `[1]`), `scales` (f32 `[3]` = `[noise_scale, length_scale, noise_w]`). Output name `"output"`, rank-4 `[1,1,1,T]`. `--rate` is mapped to Piper via `length_scale = voice_default / speed`.
- **AVSpeech** (#141, opt-in `system_tts`): `kesha-engine` spawns `$OUT_DIR/say-avspeech` (Swift, compiled by `build.rs`). UTF-8 text on stdin, voice id as argv[1]. Swift writes a complete mono f32 IEEE_FLOAT WAV @ 22050 Hz to stdout. Gotcha: AVSpeechSynthesizer callbacks dispatch on the main queue, so the helper MUST pump `CFRunLoopRun()` — `DispatchSemaphore` hangs. `--rate` not wired yet (AVSpeechUtterance has its own `.rate`, mapping TBD). SSML + AVSpeech explicitly rejected in v1.
- `KESHA_ENGINE_BIN` — override the engine-binary path (useful when iterating on `rust/target/release/kesha-engine`).
- `KESHA_CACHE_DIR` — isolated test cache.
- macOS dev runtime: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`. Release binaries fix up via `install_name_tool`.
- macOS build env: `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib`, `RUSTFLAGS="-L /opt/homebrew/lib"`.

Original spec assumed Silero TTS; pivoted to Piper during M3 spike (Silero ships PyTorch-only, no public ONNX). See `docs/superpowers/specs/2026-04-16-bidirectional-voice-design.md`.
