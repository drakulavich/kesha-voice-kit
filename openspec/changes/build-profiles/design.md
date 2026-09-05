## Context

`rust/Cargo.toml` `[features]`: `default = ["onnx", "tts"]`, `coreml = ["dep:fluidaudio-rs"]`, `tts = [...]`, `system_tts = ["tts"]`, `system_kokoro = ["tts", "dep:fluidaudio-rs"]`, `system_diarize = ["dep:fluidaudio-rs"]`, `system_text_lang = []`. `build-engine.yml:106-116` ships two rows. Distinct `cfg` predicates: 20 (`grep -rhoE '#\[cfg\([^]]+\)\]' rust/src | sort -u`).

## Goals / Non-Goals

Goals: a shipped binary is described by one word; the release-row invariant is a test, not a CLAUDE.md rule; platform branching reads as `#[cfg(darwin_native)]`. Non-goals: as in the proposal.

## Decisions

### D1. Profiles are bundles, granular features stay

```toml
[features]
default = ["portable"]
portable = ["onnx", "tts"]
darwin = ["coreml", "tts", "system_tts", "system_kokoro", "system_diarize", "system_text_lang"]
```

The granular features are not removed because four non-release builds need them (proposal). `onnx` and `coreml` stay mutually exclusive at module level as today (`rust/src/backend/mod.rs:7-10`).

### D2. cfg aliases from `build.rs`

`build.rs` emits `cargo:rustc-check-cfg` and `cargo:rustc-cfg` for `portable` (feature `onnx` and not `coreml`), `darwin_native` (feature `coreml` on `target_os = "macos"`) and `system_tts` (feature `system_tts` on macOS). Source uses `#[cfg(darwin_native)]`, never the six-way `all(feature = "...", target_os = "macos")` spelling. `rust/src/platform.rs` is the only module that mentions the raw features, exposing `pub const PROFILE: &str`.

### D3. Release rows name a profile

`build-engine.yml` rows become `features: darwin` and `features: portable` with `--no-default-features`; `tests/unit/check-workflows.test.ts` gains the assertion "every `build-engine.yml` row's `features` is exactly one of `portable`, `darwin`", replacing the CLAUDE.md matrix rule.

### D4. Gates

`just preflight`: `cargo nextest run --features portable` always; on macOS also `cargo clippy --all-targets --features darwin --no-default-features -- -D warnings` and `cargo nextest run --features darwin`. `rust-test.yml` mirrors that. The standalone `cargo check --features coreml` (`justfile:137`) is deleted; the diarize lane (`rust-test.yml:533`) keeps `coreml,system_diarize` because it exists to measure diarize in isolation.

## Risks / Trade-offs

- Mac contributors without Xcode: `portable` builds without `swiftc`; `darwin` needs Xcode Command Line Tools and the preflight says so when `swiftc` is missing.
- Local `darwin` builds compile the Swift sidecars every time; today's `coreml`-only check avoided that. Accepted: the check was the reason `diarize.rs` went unverified.

## Migration Plan

Stage 3 (parallel to stages 1–2, 2–3 PRs): Cargo profiles + aliases + `platform.rs`; then the workflow/justfile/flake rows; then the CLAUDE.md deletions.

## Open Questions

- None.
