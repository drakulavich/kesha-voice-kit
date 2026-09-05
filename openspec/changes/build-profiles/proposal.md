# Proposal: build-profiles

## Why

`rust/Cargo.toml` declares seven features (`onnx`, `coreml`, `tts`, `system_tts`, `system_kokoro`, `system_diarize`, `system_text_lang`) and the release matrix ships exactly two combinations: darwin with all six non-ONNX features, every other target with `onnx,tts`. Keeping the matrix equal to cargo's defaults is a CLAUDE.md rule ("BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS") because v1.1.0 shipped without `tts`. The 405 `cfg` attributes use 20 distinct predicates, and `diarize.rs` compiles only under `system_diarize`, which the standard verify set never enables.

## What Changes

- Two **profile features** are added as bundles over the granular ones: `portable = ["onnx", "tts"]` (default) and `darwin = ["coreml", "tts", "system_tts", "system_kokoro", "system_diarize", "system_text_lang"]`.
- Every release row in `build-engine.yml` names exactly one profile, and a test asserts it.
- `build.rs` emits cfg aliases (`portable`, `darwin_native`, `system_tts`) consumed from one `rust/src/platform.rs`; the 20 predicates collapse to at most six.
- `kesha-engine describe` reports `profile`.
- The granular features stay for the four combinations built outside the release matrix: `coreml` alone (`justfile:137`), `coreml,system_diarize` (`rust-test.yml:533`), `coreml,tts,system_tts` (`CONTRIBUTING.md:99`), and Nix on darwin-arm64, `onnx,tts,system_tts` (`flake.nix:59`), which becomes `portable` plus `system_tts`.
- `just preflight` runs `portable` always and `darwin` on macOS; `verify-darwin-full` and the standalone CoreML check fold into that.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `engine-contract`: the Engine names its profile in `describe`.
- `cli-distribution`: the Nix flake builds `portable` plus `system_tts` on darwin.

## Impact

`rust/Cargo.toml`, `rust/build.rs`, `rust/src/platform.rs` (new), every `#[cfg(...)]` site, `.github/workflows/build-engine.yml`, `.github/workflows/rust-test.yml`, `justfile`, `flake.nix`, `CONTRIBUTING.md`, `CLAUDE.md` (two rules deleted).

## Non-goals

- Removing any granular feature or changing what a shipped binary contains.
- Making Nix build the CoreML path (its sandbox cannot clone the SwiftPM dependency).
- Changing the release matrix's targets or runners.
