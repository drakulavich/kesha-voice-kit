## 1. Cargo

- [ ] 1.1 Add `portable` and `darwin` bundle features; `default = ["portable"]`
- [ ] 1.2 `build.rs`: emit `portable`, `darwin_native`, `system_tts` cfg aliases with `rustc-check-cfg`
- [ ] 1.3 `rust/src/platform.rs` with `PROFILE`; rewrite every `#[cfg(all(feature = ..., target_os = "macos"))]` to an alias; assert `grep -rhoE '#\[cfg\([^]]+\)\]' rust/src | sort -u | wc -l` ≤ 6

## 2. Rows and gates

- [ ] 2.1 `build-engine.yml` rows: `features: darwin` / `features: portable`
- [ ] 2.2 `check-workflows.ts` + test: each row names exactly one profile
- [ ] 2.3 `justfile` preflight: `portable` always, `darwin` on macOS; delete the standalone CoreML check and `verify-darwin-full`
- [ ] 2.4 `rust-test.yml` mirrors the justfile; `preflight-parity.test.ts` asserts the Rust profile commands match
- [ ] 2.5 `flake.nix` and `CONTRIBUTING.md` speak in profiles

## 3. Docs

- [ ] 3.1 Delete "BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS" and the darwin caveat in "VERIFY BEFORE PUSHING" from CLAUDE.md; move "COREML BUILD TRIPLE" points 1–2 to a comment on the `darwin` profile
