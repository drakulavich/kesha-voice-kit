# Diarize compile-cache — Implementation Plan

**Goal:** Make `kesha transcribe --speakers` fast (~4s) by loading the Sortformer model from a stable compiled `.mlmodelc` (e5rt ANE cache hits across processes) instead of recompiling a throwaway temp model every call (~100s). Warm the one-time compile at `kesha install`.

**Architecture:** Fix in the fork (`drakulavich/fluidaudio-rs`) bridge — compile-to-stable-sibling + load-from-stable via FluidAudio's public `SortformerModels(config:main:)` init; add a no-audio warm FFI. Bump the kesha fork pin and warm diarize in the existing install warm-up step. Keep #435's adaptive timeout untouched.

**Spec:** `docs/superpowers/specs/2026-05-21-diarize-compile-cache-design.md`

---

## Repo A — `drakulavich/fluidaudio-rs` (branch `fix/diarize-compile-cache`)

### Task A1: bridge — load from stable compiled `.mlmodelc`

**File:** `swift/FluidAudioBridge.swift`

- [ ] Add `private func loadSortformerCached(modelPath: String) async throws -> SortformerModels`:
  - `stableURL = URL(fileURLWithPath: modelPath + ".mlmodelc")`.
  - if `!FileManager.default.fileExists(atPath: stableURL.path)`: `let compiled = try await MLModel.compileModel(at: URL(fileURLWithPath: modelPath))`; publish atomically — if stable exists `replaceItemAt`, else `moveItem(at: compiled, to: stableURL)`.
  - `let cfg = MLModelConfiguration(); cfg.computeUnits = .all`
  - `let model = try MLModel(contentsOf: stableURL, configuration: cfg)`
  - `return try SortformerModels(config: SortformerConfig.balancedV2, main: model)`
- [ ] In `diarizeFileWithModels`, replace the two lines
  `let diarizer = SortformerDiarizer(config: .balancedV2, timelineConfig: .sortformerDefault)` + `try await diarizer.initialize(mainModelPath: URL(fileURLWithPath: modelPath))`
  with: build diarizer, `let models = try await loadSortformerCached(modelPath: modelPath)`, `diarizer.initialize(models: models)`.

### Task A2: bridge — warm method + FFI

**Files:** `swift/FluidAudioBridge.swift`, `swift/Diarize_ffi.swift`

- [ ] `FluidAudioBridgeInternal.compileDiarizationModel(modelPath:) throws` — semaphore+Task wrapper that calls `_ = try await loadSortformerCached(modelPath:)` and rethrows.
- [ ] `Diarize_ffi.swift`: `@_cdecl("fluidaudio_compile_diarization_model") func(ptr, modelPath) -> Int32` → `bridge.compileDiarizationModel(modelPath:)`, return 0 / -1 on throw (mirror existing error print).

### Task A3: Rust binding

**Files:** `src/ffi/bridge.rs`, `src/lib.rs`

- [ ] `bridge.rs`: extern decl `fn fluidaudio_compile_diarization_model(bridge, model_path: *const i8) -> i32;` + `FluidAudioBridge::compile_diarization_model(&self, model_path: &str) -> Result<(), String>`.
- [ ] `lib.rs` (near 398): `pub fn compile_diarization_model<Q: AsRef<Path>>(&self, model_path: Q) -> Result<(), FluidAudioError>` — exists-check then `self.bridge.compile_diarization_model(...).map_err(FluidAudioError::from)`.

### Task A4: verify fork + push

- [ ] `cargo build --release --example diarize`; run `examples/diarize -- /tmp/kdt/a.wav 0.6 <mlpackage>` **twice**: run1 ~100s cold, run2 **~4s** (stable `.mlmodelc` now beside the `.mlpackage`).
- [ ] Quick warm-API smoke (tiny Rust example or reuse): `compile_diarization_model(<mlpackage>)` returns Ok, creates `<mlpackage>.mlmodelc`.
- [ ] `cargo fmt && cargo clippy --all-targets -- -D warnings`. Commit, push branch, open PR in the fork. Record the merge/commit SHA.

## Repo B — kesha `fix/diarize-compile-cache` (this worktree)

### Task B1: bump fork pin

**Files:** `rust/Cargo.toml`, `rust/Cargo.lock`

- [ ] Point the `fluidaudio-rs` git dep `rev`/`branch` at the new fork SHA; `cargo check --features coreml,tts,system_kokoro,system_diarize --no-default-features` to refresh `Cargo.lock`.

### Task B2: warm diarize at install

**File:** `rust/src/cli/install.rs`

- [ ] After the ASR warm-up block, add `#[cfg(feature = "system_diarize")]` block: if `!no_warmup` and the diarize model is cached (`models::*` cache predicate), call `fluidaudio_rs::FluidAudio::new().and_then(|fa| fa.compile_diarization_model(models::model_dir(models::ModelKind::Diarize)))`, with a "Warming up diarization model (one-time, ~1-2 min)…" line; warm-up failure is **non-fatal** (match the ASR pattern). Match diarize.rs's `fluidaudio_rs` import path.

### Task B3: verify kesha

- [ ] Rebuild engine on new pin (features `coreml,tts,system_kokoro,system_diarize`). `cargo fmt` (revert `vendor/vosk-tts/src/tokenizer.rs`), `cargo clippy --all-targets ... -- -D warnings -A dead_code`, `cargo nextest run --features tts`.
- [ ] `KESHA_CACHE_DIR=/tmp/kdt/cache <engine> install --diarize` → shows diarize warm step, ends warm. (Stable `.mlmodelc` created beside the `.mlpackage`.)
- [ ] `transcribe /tmp/kdt/a.wav --json --speakers` → **~4s**, valid JSON, speaker labelled, zero E5RT on stdout. `KESHA_DIARIZE_TIMEOUT_SECS=1 …` still fast-fails. `say --voice en-am_michael` unaffected.
- [ ] PR to kesha `main`, referencing #434/#435; wait for CI + Greptile (≥4/5 on latest SHA) before merge.

## Out of scope
Engine version bump / release (separate; bundles #433 + #435 + this). Pre-compiled `.mlmodelc` in release. Runtime cold-reload timeout headroom.
