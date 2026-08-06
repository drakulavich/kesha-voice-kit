## 0. Validate the premise before writing feature code

- [x] 0.1 Spike against the pinned `fluidaudio-rs` rev `9b7ceda` (0.14.8): confirm `is_streaming_asr_available` flips on init and a chunked fixture round-trips through `start`/`feed`/`finish` (D0)
- [x] 0.2 Probe the edge cases — silence, empty session, feed-without-start, session reuse — and record what is actually trustworthy (D0)
- [x] 0.3 Confirm the partial-transcript surface does not exist at 0.14.8 *or* 0.15.5 (D0b)
- [x] 0.4 Confirm stdout stays clean, and decide the silencing policy anyway (D0c)
- [x] 0.5 Delete the spike directory

## 1. Engine: the streaming session

- [x] 1.1 `rust/src/streaming_asr.rs` under `cfg(all(feature = "coreml", target_os = "macos"))`: `StreamingAsrSession::start()` re-inits, `feed(&mut self, …)`, `finish(self)` consumes (D0)
- [x] 1.2 Every FluidAudio call wrapped in `fluid_stdout::with_silenced_stdout` with a cached `/dev/null` fd (D0c)
- [x] 1.3 `StreamResampler` holding one `rubato` resampler for the session, block-wise with a carried remainder, pass-through at 16 kHz (D2)
- [x] 1.4 One comment at the session type recording *why* it re-inits and consumes — the defect is invisible in the code

## 2. Engine: the live capture loop

- [x] 2.1 `record_default_input_live` in `rust/src/record.rs`, reusing `build_input_stream` / `mix_frame_to_mono` / `ensure_input_channels` / `spawn_stdin_stop_thread` (D1)
- [x] 2.2 Feeding happens on the draining thread, never in the CPAL callback (D1)
- [x] 2.3 `--live` on the `Record` clap variant, `conflicts_with` `--out`; non-CoreML builds reject it with `E_UNSUPPORTED_PLATFORM` rather than dropping the flag (D4)
- [x] 2.4 `cli/record.rs` prints the transcript to stdout, progress to stderr; `--out` and `--live` cannot both arrive
- [x] 2.5 `record.live` pushed onto the capabilities feature vector under the matching `cfg` (D4)

## 3. CLI

- [x] 3.1 `resolveRecordArgs` returns either `out` or `live`, rejecting both-set and neither-set with exit 2 (D3)
- [x] 3.2 `RECORD_LIVE_FEATURE` + `preflightRecordLive` in `src/engine.ts`, refusing when the flag is absent or capabilities are unreadable (D4)
- [x] 3.3 `recordEngine` spawns the live shape; stdout stays inherited so the transcript is never re-serialised by the CLI
- [x] 3.4 `--live` documented in the command's `args` and in README/docs where `record` appears

## 4. Tests

- [x] 4.1 Rust `#[ignore]`d: chunked LFS fixture through a real `StreamingAsrSession`, asserting the transcript (D5)
- [x] 4.2 Rust `#[ignore]`d: two sessions in one process return their own transcripts — the D0 regression detector
- [x] 4.3 Rust: resampler length conservation and 16 kHz pass-through, no mic involved
- [x] 4.4 Rust: `record.live` present under coreml+macOS, absent otherwise
- [x] 4.5 TS: `resolveRecordArgs` for both-set / neither-set / live-only / out-only
- [x] 4.6 TS: `preflightRecordLive` refuses on a capabilities fixture without the flag, and on unreadable capabilities

## 5. Verification

- [x] 5.1 `bun test && bunx tsc --noEmit`
- [x] 5.2 `make rust-test`, `cargo fmt`, `cargo clippy --all-targets -- -D warnings`
- [x] 5.3 `cargo check --features coreml --no-default-features`
- [x] 5.4 Local coreml build: run 4.1/4.2 with `--run-ignored`, paste the output in the PR
- [x] 5.5 Local coreml build: `--capabilities-json` lists `record.live`; the default ONNX build does not
- [x] 5.6 State in the PR that live-mic was not exercised by an agent, with the exact one-command manual check (D5)
