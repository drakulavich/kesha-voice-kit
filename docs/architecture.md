# Architecture

A contributor's map of kesha-voice-kit: where code lives, what the boundaries
are, and where to make changes. For the **user-facing** data-flow view, see the
[Architecture section in the README](../README.md#architecture). For the **why**
behind specific designs, see the spec docs under
[`docs/superpowers/specs/`](superpowers/specs/).

## Two-process model

Kesha is two programs, not one:

- **`kesha` CLI** — a thin Bun/TypeScript wrapper (`src/`). Parses commands,
  formats stdout/stderr, downloads pinned assets *only* when explicitly asked,
  and owns the local cache, support bundles, and Stats.
- **`kesha-engine`** — a standalone Rust binary (`rust/`). Does all inference
  (ASR, TTS, language detection, VAD, diarization). No cloud calls, no Python,
  no ffmpeg.

The CLI **spawns the engine as a subprocess** — it is never linked in-process.
TypeScript runs directly under Bun (no build step); the engine is a precompiled
binary downloaded from GitHub Releases during `kesha install`. The two are
[versioned independently](../CLAUDE.md) (`package.json#version` vs
`package.json#keshaEngine.version`).

## Repository map

```
src/                  Bun/TS CLI + library
  cli.ts              argument parsing, --format/--json/--toon, top-level flags
  cli/                subcommands: install, init, logs, doctor, completions, dispatch
  engine.ts          engine subprocess wrapper + getEngineCapabilities
  engine-install.ts  engine binary download (uses keshaEngine.version)
  transcribe.ts      thin forwarder to `kesha-engine transcribe`
  synth.ts           thin forwarder to `kesha-engine say`
  voice-routing.ts   omitted-`--voice` language→voice picker
  lib.ts             public API exported at @drakulavich/kesha-voice-kit/core
  *.ts               doctor, support-bundle, stats, diagnostic-log, paths, ...
  __tests__/         TS unit tests colocated with some modules

rust/src/             kesha-engine (Rust)
  main.rs            clap CLI: transcribe / say / detect-lang / install / record / ...
  capabilities.rs    --capabilities-json (single source of truth for feature flags)
  models.rs          HF download + cache + SHA-256 pins for every model
  audio.rs           symphonia decode + rubato resample to 16kHz mono f32
  lang_id.rs         SpeechBrain ONNX audio language detection (always built)
  text_lang.rs       macOS NLLanguageRecognizer (macOS only)
  vad.rs             Silero VAD v5
  backend/           ASR backends — onnx.rs, fluidaudio.rs (coreml), mod.rs (trait)
  transcribe/        transcribe pipeline + diarize.rs
  tts/               kokoro.rs (en), vosk.rs (ru), avspeech.rs (macos), g2p, ssml/, en/, ru/

tests/                bun tests — unit/, integration/, fixtures/, helpers/
rust/tests/           nextest integration binaries (tts_e2e, diarize_e2e, ssml_integration, ...)
.github/workflows/    ci, rust-test, build-engine, security, npm-publish, homebrew-tap, linux-packages, docker
raycast/              Raycast extension (its own package.json)
packaging/            deb/rpm nfpm config
flake.nix             Nix build path (aarch64-darwin, x86_64-linux)
SKILL.md              OpenClaw skill manifest (shipped in the npm package)
```

## CLI ↔ engine boundary

1. A `kesha <cmd>` call is parsed in `src/cli.ts` / `src/cli/dispatch.ts`.
2. Commands that need inference (`transcribe`, `say`, `detect-lang`) forward to
   the engine via `src/engine.ts`, which locates the binary
   (`KESHA_ENGINE_BIN` override → installed cache path) and spawns it with
   `Bun.spawn`.
3. The CLI reads the engine's capability surface via
   `kesha-engine --capabilities-json` (`src/engine.ts::getEngineCapabilities`)
   and validates flags against it instead of blindly forwarding — see the
   "DO NOT BLINDLY FORWARD CLI FLAGS" rule in [CLAUDE.md](../CLAUDE.md).
4. **stdout is the result** (transcript / JSON / WAV bytes); **stderr is
   progress + errors**. This keeps stdout pipe-friendly.
5. **Assets are install-only.** `kesha install` (and opt-in `--tts` / `--vad` /
   `--diarize`) populate the cache; ordinary commands fail fast with an
   actionable hint if an asset is missing — the engine is never auto-downloaded
   on first transcription.

## ASR & TTS backends

**Compile-time feature gating** (`rust/Cargo.toml`): the engine ships in
per-platform variants selected by cargo features, mirrored in every
`build-engine.yml` matrix row.

- ASR: exactly **one** backend per binary, no runtime fallback —
  `coreml` (FluidAudio / Apple Neural Engine, darwin-arm64) or `onnx`
  (ONNX Runtime, Linux/Windows/fallback). They're mutually exclusive at the
  module level (`backend/mod.rs` trait, `onnx.rs`, `fluidaudio.rs`).
- `lang_id.rs` always uses ONNX regardless of ASR backend.
- TTS (`tts` feature): routed by **voice-id prefix** in `tts/mod.rs` —
  `en-*` → Kokoro (`kokoro.rs`), `ru-*` → Vosk-TTS (`vosk.rs`),
  `macos-*` → AVSpeech (`avspeech.rs`).

**Sidecars** are resolved at runtime sibling-first (next to the engine binary,
then build-time `$OUT_DIR`): the `say-avspeech` Swift helper (`system_tts`,
darwin) and the native `fluidaudio-rs` CoreML path (`coreml` / `system_diarize`).

## Models: cache + pinning

- Cache lives under `~/.cache/kesha/models/` (override `KESHA_CACHE_DIR`).
- Every model file in `rust/src/models.rs` carries a pinned **SHA-256**;
  `download_verified` refuses to cache a file whose hash doesn't match. This
  makes `KESHA_MODEL_MIRROR` safe and turns an upstream re-publish into a
  deliberate pin bump (see the `verify-pin-bump` skill).
- Diarization compiles its `.mlpackage` to a stable `.mlmodelc` sidecar warmed
  at `install --diarize`; Apple's e5rt cache is keyed by compiled-bundle
  identity, so a recompile is a cold ~98 s cost (see
  [#444](https://github.com/drakulavich/kesha-voice-kit/issues/444)).

## Build, test & release

- **TS tests:** `tests/unit/` + `tests/integration/` (and some colocated
  `src/**/__tests__/`), run with `bun test` / `make test`.
- **Rust tests:** `cargo nextest run --features tts` / `make rust-test`; nextest
  integration binaries live in `rust/tests/`. Never plain `cargo test` (CI uses
  nextest) except `cargo test --doc`.
- **CI:** `ci.yml` (TS units + integration + type check), `rust-test.yml`
  (fmt/clippy/nextest + coreml feature check; PR + lean push-to-main gate),
  `security.yml` (cargo-deny + bun audit), `build-engine.yml` (tag → 3 platform
  binaries + draft release), `npm-publish.yml`, `homebrew-tap.yml`,
  `linux-packages.yml`, `docker.yml`.
- **Releases:** CLI and engine version independently; the full procedure
  (lockstep bump → tag → draft validation → un-draft → npm publish) is in
  [CLAUDE.md](../CLAUDE.md) and the `release-engine` skill.
- **Nix:** `flake.nix` builds the engine + CLI on `aarch64-darwin` /
  `x86_64-linux`; not a CI gate.

## Integration surfaces

- **OpenClaw:** `SKILL.md` (shipped in the npm package) documents the
  `tools.media.audio.models` CLI route and TTS provider config;
  `openclaw.plugin.json` + `openclaw-plugin.cjs` register the plugin.
- **Raycast:** the `raycast/` extension (its own package, own lockfile).
- **Programmatic API:** `@drakulavich/kesha-voice-kit/core` re-exports
  `transcribe`, `downloadEngine`, `getEngineCapabilities` from `src/lib.ts`.

## Where to change X

| If you're changing… | Touch | Verify with |
|---|---|---|
| A CLI flag / output format | `src/cli.ts`, `src/cli/*`, `src/format.ts` | `bun test && bunx tsc --noEmit` |
| ASR pipeline | `rust/src/backend/`, `rust/src/transcribe/` | `make rust-test` + `cargo check --features coreml --no-default-features` |
| A TTS voice/engine | `rust/src/tts/`, `src/voice-routing.ts` | `make rust-test`; `cargo nextest run --features tts tts_` |
| A model version/pin | `rust/src/models.rs` | `verify-pin-bump` skill; `cargo test models::manifest_tests` |
| Shell completions / manpage | regenerate, don't hand-edit | `bun run generate:shell-artifacts` |
| A GitHub workflow | `.github/workflows/*` | `bun run check:workflows` + `actionlint` |
| The OpenClaw skill | `SKILL.md` | cross-check against live `kesha <cmd> --help` |

When in doubt, the agent-facing rules in [CLAUDE.md](../CLAUDE.md) capture the
hard constraints (bun-only, no auto-download, male default voices, pinned
hashes, isolated worktrees) that this map only summarizes.
