# Diarize compile-cache — restore `--speakers` performance

**Status:** design approved (direction + warm mechanism), pending spec review
**Date:** 2026-05-21
**Branch (kesha):** `fix/diarize-compile-cache` (off `main`@47a824a / #435)
**Repos:** `drakulavich/fluidaudio-rs` (the fork — primary change) + `drakulavich/kesha-voice-kit`

## Problem

`kesha transcribe --json --speakers` takes ~90-105s **every call** and trips the 90s
adaptive timeout added in #435 → users get an error instead of speaker labels. Neither
#433 nor #435 is released yet, so no shipped binary is broken; this gates the engine
release that would bundle #433 + #435 + this fix.

## Root cause (confirmed by spike, M3 Pro, 2026-05-21)

`FluidAudioBridge.swift::diarizeFileWithModels` → `SortformerModels.load()` runs
`MLModel.compileModel(at: <.mlpackage>)` to a **throwaway temp `.mlmodelc`** and loads it
with `computeUnits = .all` on **every process**. The cost is the CoreML **ANE program
compilation** inside `MLModel(contentsOf:, .all)`, which Apple caches in
`~/Library/Caches/com.apple.e5rt.e5bundlecache` **keyed to the compiled model's path**.
A fresh temp path every run ⇒ cache key changes ⇒ miss ⇒ full cold compile every run.

| Step | Time |
|---|---|
| `compileModel(.mlpackage → .mlmodelc)` | 0.3s |
| `MLModel(contentsOf: stable.mlmodelc, .all)` — cold (1st process) | 104.7s |
| `MLModel(contentsOf: stable.mlmodelc, .all)` — warm (2nd process) | **3.9s** |

It was **not** thread QoS (the merged #435 worker-thread theory was wrong: a main-thread
build is still 92s) and **not** `compileModel`. The fast auto-download path (`diarize_file`)
is ~4s only because it loads a stable, pre-compiled `.mlmodelc`. `MLModel(contentsOf:
.mlpackage)` directly is rejected by this OS ("not a valid .mlmodelc") — we must compile to
a stable `.mlmodelc` explicitly.

## Design

### 1. Fork: load from a stable compiled `.mlmodelc` (the fix)

`drakulavich/fluidaudio-rs` is pinned to upstream `FluidAudio` exact `0.14.5` (not forkable
cheaply), so the bridge uses only FluidAudio **public** API. `SortformerModels.init(config:
main: compilationDuration:)` is public and takes a `main: MLModel`, so the bridge can load
the model itself and skip `SortformerModels.load()`'s temp recompile.

`swift/FluidAudioBridge.swift` — add a private helper:

```
loadSortformerCached(mlpackagePath:) -> SortformerModels
  stable = mlpackagePath + ".mlmodelc"        // sibling, in kesha's writable cache dir
  if !exists(stable):
      compiled = MLModel.compileModel(at: mlpackagePath)   // 0.3s
      atomically move/replace compiled -> stable
  model = MLModel(contentsOf: stable, configuration: { computeUnits = .all })
  return try SortformerModels(config: .balancedV2, main: model)
```

- `diarizeFileWithModels` swaps `diarizer.initialize(mainModelPath:)` →
  `diarizer.initialize(models: loadSortformerCached(modelPath))`.
- Stable path derivation lives in the bridge (sibling `<.mlpackage>.mlmodelc`), so the
  Rust/FFI signatures for diarize stay unchanged.
- Atomic replace (compile to temp, then `replaceItemAt`) so concurrent/interrupted runs
  can't leave a half-written `.mlmodelc`.

### 2. Fork: dedicated warm API (no fake audio)

- `swift/Diarize_ffi.swift`: new `@_cdecl fluidaudio_compile_diarization_model(ptr,
  modelPath) -> Int32` → calls `bridge.loadSortformerCached(modelPath)` and discards the
  result (the `MLModel(contentsOf:, .all)` load populates the e5rt cache; ANE compile
  happens here).
- `src/ffi/bridge.rs`: extern decl + `FluidAudioBridgeInternal::compile_diarization_model`.
- `src/lib.rs`: `FluidAudio::compile_diarization_model<P: AsRef<Path>>(model_path) ->
  Result<(), FluidAudioError>` (mirror `diarize_file_with_models`, near lib.rs:398).

### 3. Kesha: warm at install, pin bump

- `rust/Cargo.toml` + `Cargo.lock`: bump the `fluidaudio-rs` git pin to the new fork SHA.
- `rust/src/main.rs` install flow: the existing warm-up step (`--no-warmup`,
  main.rs:101-110) already triggers the ASR ANE compile. Extend it so that **when the
  current install requested the diarize model** (`--diarize`) and `!no_warmup`, it calls
  `FluidAudio::compile_diarization_model(diarize_model_dir)` once inside the existing
  stdout-silencing helper — paying the ~100s ANE compile at the explicit install step.
  Print a progress line ("Warming diarization model (one-time compile ~1-2 min on first
  install, ~4 s after)…"). Skipped on `--no-warmup` and on non-`system_diarize` builds.
- After a successful diarize warm-up, remove stale Kesha-owned compiled sidecars
  (`*.mlpackage.mlmodelc`) next to the active diarize `.mlpackage`. Keep the current warmed
  sidecar and all source `.mlpackage` directories; never touch Apple's e5rt cache.
- Runtime `transcribe --speakers` is unchanged (`diarize.rs` keeps #435's adaptive timeout
  + worker thread); after install-warm it loads the stable `.mlmodelc` in ~4s.

### 4. Timeout / edge cases

- Keep #435's adaptive timeout as a safety net. With warm install it never fires (4s ≪ 90s).
- Edge case: if the OS evicts the e5rt cache, a runtime `--speakers` load is cold (~100s)
  and would exceed the 90s floor → error. Acceptable for v1 (diarize is opt-in); the error
  hint should suggest re-running `kesha install`. (Optional follow-up: detect cold reload
  and extend the budget. Out of scope for this fix.)

## Testing / verification

- **Spike already done** (the premise): cold 104.7s, warm 3.9s across processes.
- Fork: `cargo run --release --example diarize -- /tmp/kdt/a.wav 0.6 <mlpackage>` twice —
  expect run 1 ~100s (cold/compile), run 2 ~4s (warm). Plus `compile_diarization_model`
  smoke (returns 0, creates `<mlpackage>.mlmodelc`).
- Kesha: rebuild engine on the new pin; `kesha install --diarize` shows the warm step and
  ends warm; `transcribe a.wav --json --speakers` is ~4s, valid JSON, speaker labelled,
  zero E5RT on stdout (StdoutShield from #433 still applies). `cargo nextest run
  --features tts` green; clippy `-D warnings` on the full feature set.
- `say --voice en-am_michael` unaffected (Kokoro).

## Release

Engine release (separate, after both PRs merge): bump `rust/Cargo.toml`,
`package.json#keshaEngine.version`, `package.json#version`, `Cargo.lock`; tag →
build-engine.yml; draft-validate the darwin-arm64 binary with a real `--json --speakers`
(warm) + Kokoro smoke; un-draft to publish. Bundles #433 + #435 + this fix.

## Out of scope

- Shipping a pre-compiled `.mlmodelc` in the release (portability across macOS/chip
  unverified; on-device warm is reliable and cheap after first run).
- Runtime cold-reload timeout headroom / e5rt-eviction recovery.
- Persisting the e5rt cache ourselves (it's OS-managed and already cross-process).
