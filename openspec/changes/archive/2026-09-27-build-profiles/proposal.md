# Proposal: build-profiles

## Why

`rust/Cargo.toml` declares seven features (`onnx`, `coreml`, `tts`, `system_tts`, `system_kokoro`, `system_diarize`, `system_text_lang`) and the release matrix ships exactly two combinations: darwin with all six non-ONNX features, every other target with `onnx,tts`. Keeping the matrix equal to cargo's defaults is a rule in `.claude/rules/ci-and-build.md` ("BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS") because v1.1.0 shipped without `tts`: a rule a reader has to remember, not a check that fails. The source spells the macOS-only feature gates as `all(feature = "...", target_os = "macos")` at 187 sites under `rust/src` and `rust/tests`, with the negated and `test`-widened variants on top, so the question "is this the darwin build?" has a dozen spellings.

## What Changes

- Two **profile features** are added as bundles over the granular ones: `portable = ["onnx", "tts"]` (default) and `darwin = ["coreml", "tts", "system_tts", "system_kokoro", "system_diarize", "system_text_lang"]`.
- Every release row in `build-engine.yml` names exactly one profile, and `check-workflows.ts` fails a row that does not.
- `build.rs` emits cfg aliases (`portable`, `darwin_native`, `system_tts`, `system_kokoro`, `system_diarize`, `system_text_lang`); no `#[cfg]` under `rust/src` or `rust/tests` spells a feature together with `target_os = "macos"` any more.
- `kesha-engine describe` already reports `profile` (protocol v4, #1156); its value now comes from `rust/src/platform.rs::PROFILE`, and a unit test pins it to the bundle the build enabled. The value on every release binary is unchanged, so the recorded capability pacts stay as they are.
- The granular features stay for the combinations built outside the release matrix: `coreml` alone (`rust-test.yml:158`, `cache-seed.yml:140`), `coreml,system_diarize` (`.github/scripts/coreml-regression.sh:7`), `coreml,system_kokoro` (`justfile:87`, `ane-tests`), and Nix on darwin-arm64, `onnx,tts,system_tts` (`flake.nix:59-61`), which becomes `portable,system_tts`.
- There is no local pre-push gate any more (`just preflight` was retired in #1270; CI on the head SHA is the gate). `just verify-darwin-full`, which `rust-test.yml` runs on macOS, lints the `darwin` profile instead of spelling out its six features; the Rust test lanes keep the `portable` default.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `engine-contract`: every release Engine is built from exactly one named profile, which `describe` reports.
- `cli-distribution`: the Nix flake builds `portable` plus `system_tts` on darwin.

## Impact

`rust/Cargo.toml`, `rust/build.rs`, `rust/src/platform.rs` (new), `rust/src/protocol/describe.rs`, every macOS feature `#[cfg(...)]` site, `.github/workflows/build-engine.yml`, `.github/workflows/ci.yml`, `.github/scripts/check-workflows.ts`, `justfile`, `flake.nix`, `.github/workflows/nix-build.yml` (comment), `CONTRIBUTING.md`, `CLAUDE.md`, `.claude/rules/ci-and-build.md`.

## Non-goals

- Removing any granular feature or changing what a shipped binary contains.
- Making Nix build the CoreML path (its sandbox cannot clone the SwiftPM dependency).
- Changing the release matrix's targets or runners.
- Running the Rust test suite under the `darwin` profile in CI; that needs the ANE models on the runner and is its own change.
