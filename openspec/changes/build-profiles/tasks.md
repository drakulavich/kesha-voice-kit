## 1. Cargo

- [x] 1.1 Add `portable` and `darwin` bundle features; `default = ["portable"]`
- [x] 1.2 `build.rs`: emit `portable`, `darwin_native`, `system_tts`, `system_kokoro`, `system_diarize`, `system_text_lang` cfg aliases with `rustc-check-cfg`, keyed on the target OS
- [x] 1.3 Rewrite every `cfg` that spells a feature together with `target_os = "macos"` under `rust/src` and `rust/tests` (multi-line ones included) to an alias; none remain
- [x] 1.4 `rust/src/platform.rs::PROFILE` replaces `describe.rs::profile`; a unit test asserts `PROFILE` equals the compiled bundle (`portable` or `darwin`)

## 2. Rows and gates

- [x] 2.1 `build-engine.yml` rows: `features: darwin` / `features: portable`; `cargo tree -e features` per row is identical before and after apart from the bundle feature itself
- [x] 2.2 `check-workflows.ts` + test: each release row names exactly one profile (test red before the rows change; `just mutate` reports PINNED)
- [x] 2.3 `justfile`: `verify-darwin-full` lints `--features darwin`; `rust-test.yml` keeps calling it and keeps the standalone `coreml` check
- [x] 2.4 `ci.yml` local engine build uses `portable`
- [x] 2.5 `flake.nix`, `nix-build.yml` comment and `CONTRIBUTING.md` speak in profiles

## 3. Docs

- [x] 3.1 Delete "BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS" from `.claude/rules/ci-and-build.md`; move "COREML BUILD TRIPLE" points 1–2 to a comment on the `darwin` profile; CLAUDE.md's Cargo-features line and `verify-darwin-full` caveat speak in profiles
