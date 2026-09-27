## Context

`rust/Cargo.toml` `[features]`: `default = ["onnx", "tts"]`, `coreml = ["dep:fluidaudio-rs"]`, `tts = [...]`, `system_tts = ["tts"]`, `system_kokoro = ["tts", "dep:fluidaudio-rs"]`, `system_diarize = ["dep:fluidaudio-rs"]`, `system_text_lang = []`. `build-engine.yml:99-111` ships three rows over two feature sets. `rust/src` carries 454 `cfg` attributes over 33 distinct predicates (`grep -rhoE '#\[cfg\([^]]+\)\]' rust/src | sort -u`); 58 `cfg` sites under `rust/src` and `rust/tests` spell a feature together with `target_os = "macos"`.

`describe` already carries `profile` since protocol v4 (#1156), derived inline in `rust/src/protocol/describe.rs::profile` from `feature = "coreml"`.

`just preflight` was retired in #1270: CI on the head SHA is the only gate. `just verify-darwin-full` stays, and `rust-test.yml` runs it on macOS-14 so CI and the local recipe cannot drift (#797).

## Goals / Non-Goals

Goals: a shipped binary is described by one word; the release-row invariant is a check, not a rule file paragraph; platform branching reads as `#[cfg(darwin_native)]`. Non-goals: as in the proposal.

## Decisions

### D1. Profiles are bundles, granular features stay

```toml
[features]
default = ["portable"]
portable = ["onnx", "tts"]
darwin = ["coreml", "tts", "system_tts", "system_kokoro", "system_diarize", "system_text_lang"]
```

The granular features are not removed because four non-release combinations need them (proposal). `onnx` and `coreml` stay mutually exclusive at module level as today (`rust/src/backend/mod.rs`).

### D2. cfg aliases from `build.rs`

`build.rs` declares every alias with `cargo:rustc-check-cfg` and sets it with `cargo:rustc-cfg`, reading `CARGO_FEATURE_*` and `CARGO_CFG_TARGET_OS` (the target, not the host the build script runs on):

| alias | set when |
|---|---|
| `portable` | feature `onnx` and not `coreml` |
| `darwin_native` | feature `coreml`, target macOS |
| `system_tts` | feature `system_tts`, target macOS |
| `system_diarize` | feature `system_diarize`, target macOS |
| `system_text_lang` | feature `system_text_lang`, target macOS |

`system_diarize` and `system_text_lang` join the three aliases first proposed because leaving them would keep the `all(feature, target_os)` spelling at 14 sites. Source uses the alias; a bare `#[cfg(feature = "system_diarize")]` that means "the feature, on any target" stays as it is. `build.rs` itself cannot see its own aliases, so it keeps the raw spelling.

Measured result: no `#[cfg]` or `cfg!` under `rust/src` or `rust/tests` names a feature together with `target_os = "macos"`, and the distinct-predicate count drops. The first draft's "20 predicates collapse to at most six" counted `test`, `unix`, `feature = "tts"` and the other non-platform predicates too, which no alias touches; it is replaced by the zero-spelling assertion.

### D3. `platform.rs` owns the profile name

`rust/src/platform.rs::PROFILE` is `"darwin"` under `darwin_native` and `"portable"` otherwise, the same mapping `describe.rs::profile` used, so no release binary's `describe` changes and the recorded capability pacts need no re-record. A unit test asserts `PROFILE` equals the bundle feature the build enabled (`darwin` when `feature = "darwin"`, `portable` when `feature = "portable"` alone).

### D4. Release rows name a profile

The release workflow's build rows become `features: darwin` and `features: portable`, still with `--no-default-features` (`.github/workflows/build-engine.yml:99-111`; `unified-release` later folds them into `release.yml`). `.github/scripts/check-workflows.ts::requireReleaseRowsNameOneProfile` fails any build row whose `features` is not exactly one of `portable`, `darwin`, naming the row and the two allowed profiles; it replaces the rule-file matrix paragraph. `ci.yml`'s local engine build, which mirrors the Linux row, uses `portable` too.

### D5. Gates

There is no local pre-push gate. `just verify-darwin-full` becomes `cargo clippy --all-targets --no-default-features --features darwin -- -D warnings`; `rust-test.yml` already calls the recipe on macOS-14. The Rust test lanes keep running the `portable` default. The standalone `cargo check --features coreml --no-default-features --all-targets` step in `rust-test.yml` stays: `cache-seed.yml` builds exactly that combination, and nothing else compiles it. The coreml-regression lane keeps `coreml,system_diarize`.

## Risks / Trade-offs

- Mac contributors without Xcode: `portable` builds without `swiftc`; `darwin` needs Xcode Command Line Tools, as `system_tts` already did.
- A cfg alias whose `build.rs` condition is wrong silently compiles code out. The release-row feature evidence (`cargo tree -e features`) proves only the feature sets; `verify-darwin-full` and the macOS test lane compile the aliased paths, and `describe`'s `features` on each release binary is re-derived by the capability pact.

## Migration Plan

One PR: Cargo profiles, aliases and `platform.rs`; the workflow, justfile and flake rows; the rule-file deletions.

## Open Questions

- None.
