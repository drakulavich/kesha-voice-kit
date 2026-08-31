## Why

`kesha install` on darwin-arm64 downloads the 2.43 GB Parakeet TDT v3 **ONNX** weight set, and
the CoreML Engine it just installed cannot open a single byte of it. That is ~72% of the install
payload spent on files nothing will read — and since #681 made the model phase visible, it is
also ~72% of what a new macOS user now watches tick by.

Measured on an M2 after a normal install:

```
2431.8 MB  ~/.cache/kesha/models/parakeet-tdt-v3     <- unusable on a coreml build
  82.1 MB  ~/.cache/kesha/models/lang-id-ecapa
```

while the weights that Transcription actually runs on live in FluidAudio's own cache,
`~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3`, ~473 MB. (A `…-v3-coreml` sibling also exists on disk; nothing in the current FluidAudio resolves to it, so it is not counted.)

The cause is that `models::install` has no backend branch and `ASR_FILES` carries no `cfg` gate,
so the ONNX manifest compiles into — and downloads on — every build, including the one whose
`create_backend` does `let _ = model_dir;`.

## What Changes

- A CoreML build no longer downloads the ONNX ASR manifest. Language ID, VAD, TTS and the
  Engine binary are unaffected.
- `kesha install --plan` stops quoting an ASR bundle the platform will not fetch, and names the
  CoreML bundle the warm-up pulls instead, so the number shown before download matches what is
  downloaded.
- `kesha status --disk` and `kesha doctor` report ASR from FluidAudio's external cache on a
  CoreML build rather than pointing at an ONNX directory that will now be absent — otherwise a
  perfectly healthy macOS install would render as "ASR missing" and send users to reinstall.
- The Transcription pre-flight that today gates on the ONNX directory keeps working on CoreML
  without pretending that directory means anything there.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `installation`: the stated install cost becomes backend-dependent instead of one blanket
  figure, because the two backends no longer download the same set.
- `diagnostics`: `status --disk` and `doctor` report the ASR component from the backend's real
  location — extending the treatment the spec already gives the FluidAudio *Kokoro* cache to the
  ASR bundle, which is the same situation and was simply missed.

## Non-goals

- **Changing which weights CoreML Transcription uses.** FluidAudio keeps managing its own
  bundle, at its own path, on its own schedule.
- **Making the FluidAudio fetch explicit.** Today the bundle is pulled by the install-time
  warm-up, and by first use when `--no-warmup` was passed. That is pre-existing behaviour and is
  not touched here; if it should become an explicit, hash-pinned download, that is its own change.
- **The `es/fr/it/pt` CharsiuG2P set**, which darwin also downloads and also does not use
  (FluidAudio has its own G2P). Same class of waste, deliberately separate — it needs its own
  measurement and its own scenarios.
- **Anything about the Actions cache budget.** This change shrinks `macOS-kesha-engine-v1` as a
  side effect, which #675 depends on, but no CI file changes here.

## Impact

- `rust/src/models/manifest.rs` (`ASR_FILES` gating), `rust/src/models/paths.rs` (`is_cached_in`),
  `rust/src/models/mod.rs` (`install`), `rust/src/transcribe/mod.rs`
  (`ensure_asr_installed`), `rust/src/cli/install.rs` (warm-up path).
- `src/install-plan.ts`, `src/status.ts`, `src/doctor.ts` — the user-facing half.
- macOS users: ~2.43 GB less downloaded and stored per install.
- CI: `macOS-kesha-engine-v1` drops from 2350 MB to ~140 MB, which is the headroom #675 needs.
- **Every touched surface is user-visible on macOS.** The risk is not a crash; it is a healthy
  install that *looks* broken because a diagnostic still points at the old path.

Closes #684. Unblocks #675.
