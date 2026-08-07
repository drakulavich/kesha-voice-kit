## 1. Spike: confirm the controls work against the pinned v2 model

- [x] 1.1 Run `SortformerDiarizer.processComplete` at FluidAudio 0.15.5 against
      `SortformerNvidiaLow_v2.mlpackage` with a `progressCallback` — 191 reports for 92.4 s
      of audio, monotonic
- [x] 1.2 Cancel the enclosing `Task` mid-run — `CancellationError` 0.06 s later, at chunk 4
- [x] 1.3 Load on `.all` / `.cpuAndGPU` / `.cpuOnly` — 17.5 s / 32.1 s / 68.5 s processing,
      identical output (22 segments, 2 speakers)
- [x] 1.4 Split the pre-processing latency: compile 0.27 s, load 107.33 s cold vs 0.75–4.4 s
      warm — #443 is the load, not the diarization
- [x] 1.5 Delete the spike

## 2. Binding: `drakulavich/fluidaudio-rs`, branch `feat/diarize-control`

- [x] 2.1 `fluidaudio_diarize_file_with_models_controlled` beside the existing symbol,
      carrying compute units, a cancel token, and a progress callback + context (D3)
- [x] 2.2 Cancel-token trio (`_new` / `_cancel` / `_free`) over a retained Swift class,
      thread-safe and sticky (D2)
- [x] 2.3 Key the `MLModel` cache by path *and* compute units (D3)
- [x] 2.4 Rust side: `DiarizeComputeUnits`, `DiarizeCancelToken`, `DiarizeProgress`,
      `DiarizeOutcome`, and `diarize_file_with_models_controlled`
- [x] 2.5 FFI tests: path validation, progress monotonicity, cancel-before-start,
      cancel-mid-run
- [x] 2.6 `examples/diarize.rs` takes the preset as a 4th argument and prints progress
- [x] 2.7 `cargo clippy --all-targets -- -D warnings` clean, push the branch

## 3. Engine: supervise the run

- [x] 3.1 Bump the `fluidaudio-rs` pin to the fork branch rev
- [x] 3.2 Replace `run_with_timeout` with `run_supervised`: worker forwards progress over
      the channel, supervisor owns stderr and the budgets (D1, D4)
- [x] 3.3 Per-phase budgets replace the adaptive formula; delete
      `DEFAULT_DIARIZE_TIMEOUT_SECS` and friends (D1)
- [x] 3.4 Check the optional total deadline per iteration, not in the timeout arm (D1)
- [x] 3.5 `stop_worker` cancels and waits for acknowledgement before the caller bails (D2)
- [x] 3.6 Phase-specific error text: a load stall names the cold ANE compile, a processing
      stall does not, a cap blames the cap
- [x] 3.7 `KESHA_DIARIZE_COMPUTE_UNITS` with `E_INVALID_ARG` on a typo (D3)
- [x] 3.8 Unit tests for every error string, the ratio helper, and both env vars

## 4. Surfaces and gates

- [x] 4.1 `KESHA_DIARIZE_COMPUTE_UNITS` in `doctor.ts`'s known-env list
- [x] 4.2 `e2e-engine.test.ts` skips on `E_DIARIZE_TIMEOUT` rather than one message wording
- [x] 4.3 `bun test` (776 pass), `bunx tsc --noEmit`
- [x] 4.4 `cargo fmt`, `cargo clippy --all-targets -- -D warnings`,
      `cargo check --features coreml --no-default-features`,
      `cargo check --features system_diarize --no-default-features`, `make rust-test`
- [x] 4.5 Evidence: cold run (107.3 s load, visible), warm run (4.4 s load, 2 speakers over
      37 segments), forced cap (exit 1, not 139), `cpu-and-gpu` (same labels, 69 s)

## 5. Review response: name the phases the binding can actually see

- [x] 5.1 Binding: a one-shot model-ready marker between the `MLModel` load and
      `processComplete`, delivered over the same callback context as progress; the Rust
      side becomes `DiarizeEvent::{ModelReady, Progress}` (D1)
- [x] 5.2 Binding: un-`#[ignore]` the diarize FFI tests — they are gated on
      `FLUIDAUDIO_TEST_DIARIZE_MODEL`/`_AUDIO` and skip themselves without it — and cover
      the marker's ordering
- [x] 5.3 Engine: three phases (load / read / process), each with the budget its own work
      justifies; the read budget is the only one that scales with the audio (D1)
- [x] 5.4 Engine: `KESHA_DIARIZE_LOAD_TIMEOUT_SECS`, so the load-stall error names a knob
      that can act on the load; the total cap is no longer offered as one
- [x] 5.5 Engine: a `Cancelled` outcome reaching the `Finished` arm reports
      `E_DIARIZE_TIMEOUT`, not `E_INTERNAL`; `stop_worker` returns spans that arrive during
      the grace window instead of discarding a complete answer
- [x] 5.6 `KESHA_DIARIZE_TIMEOUT_SECS` and `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` in
      `doctor.ts`; `docs/errors.md` describes the phases
- [x] 5.7 e2e: `--speakers` asserts `diarize:` progress on stderr with pure JSON on stdout,
      and a forced cap asserts a coded `E_DIARIZE_TIMEOUT` with a clean exit
