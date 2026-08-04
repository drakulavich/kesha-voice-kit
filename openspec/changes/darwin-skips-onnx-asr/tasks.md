## 1. Engine: stop downloading what CoreML cannot read

- [x] 1.1 Add a `fluidaudio_asr_dir()` helper next to `fluidaudio_ane_kokoro_dir`, resolving `<ApplicationSupport>/FluidAudio/Models/parakeet-tdt-0.6b-v3` — the `-coreml` suffix is stripped by `Repo.folderName`, so do not key on the `…-v3-coreml` sibling (D2)
- [x] 1.2 Gate `ASR_FILES` and its `is_cached_in` arm on `#[cfg(not(feature = "coreml"))]` (D1)
- [x] 1.3 Drop `ASR_FILES` from `models::install`'s manifest on coreml builds; leave Language ID, VAD and TTS untouched
- [x] 1.4 `transcribe::ensure_asr_installed` checks FluidAudio's cache on coreml and keeps the existing hint text shape (D2)
- [x] 1.5 `cargo check --features coreml --no-default-features` and the default build both clean

## 2. CLI: make the promise match the download

- [x] 2.1 `install-plan.ts` emits the FluidAudio ASR row on darwin-arm64 instead of the ONNX bundle, with size and "fetched by the backend" framing (D3)
- [x] 2.2 `status.ts --disk` reports ASR from FluidAudio's cache on a CoreML engine, marked external like the Kokoro row (D4)
- [x] 2.3 `doctor.ts` does the same, and its ASR check passes on a healthy CoreML install
- [x] 2.4 Neither surface names `models/parakeet-tdt-v3` on a CoreML engine

## 3. Tests

- [x] 3.1 Rust: `models::install` manifest excludes ASR under coreml and includes it otherwise
- [x] 3.2 Rust: `is_cached(Asr)` / `ensure_asr_installed` behaviour on both feature sets
- [x] 3.3 TS: `install-plan` snapshot for darwin-arm64 has no ONNX ASR bundle and does list the external one
- [x] 3.4 TS: `status --disk` and `doctor` render the external ASR row on a CoreML capabilities fixture
- [x] 3.5 Check `manifest_tests` and `install_plan_model_paths_match_runtime_manifests` still hold under both feature sets

## 4. Verification

- [x] 4.1 `bun test && bunx tsc --noEmit`
- [x] 4.2 `make rust-test`, `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, plus `cargo check --features coreml --no-default-features`
- [x] 4.3 Local coreml build: `kesha install --plan` on darwin quotes no ONNX ASR and names the external bundle
- [x] 4.4 Local coreml build against a scratch `KESHA_CACHE_DIR`: install, then confirm `models/parakeet-tdt-v3` is absent and transcription still works
- [x] 4.5 `kesha status --disk` and `kesha doctor` on that install both report ASR healthy, neither names the ONNX path — the regression this change most risks (Risks)
- [x] 4.6 Measure the new macOS install payload and record it against the 2.43 GB claimed saving

## 5. Land

- [ ] 5.1 PR body with `Closes #684`, the before/after payload numbers, and the note that PR CI never runs the coreml branch
- [ ] 5.2 Wait for CI and Greptile on the head SHA; resolve P1/P2 findings
- [ ] 5.3 Comment on #675 that the budget headroom is now available, and re-plan the cache work against the new `macOS-kesha-engine-v1` size
