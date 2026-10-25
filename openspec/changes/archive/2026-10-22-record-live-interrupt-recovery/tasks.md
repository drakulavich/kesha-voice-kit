## 1. Engine: recovery audio

- [x] 1.1 Extract `wav_header_bytes` from `write_plain_mono_float_wav` so both writers emit one header layout
- [x] 1.2 `record::spill::SpillWav`: create with a zero-length header, append samples, rewrite the sizes every `SYNC_SAMPLES`
- [x] 1.3 `recovery_dir()` under `models::cache_dir()`, timestamped `live-<epoch>-<pid>.wav` names
- [x] 1.4 `prune_stale_spills` at session start, 7-day retention, only files this writer named
- [x] 1.5 Spill from `LiveFeed::feed`, before the resample, and drop the spill (loudly) rather than the session on an I/O error

## 2. Engine: finishing on a signal

- [x] 2.1 `record::interrupt`: `libc::signal` for SIGINT/SIGTERM, handler stores to an `AtomicI32` and re-arms `SIG_DFL` so a second Ctrl-C reaches a wedged session; `install` clears the flag and runs before CPAL spawns threads
- [x] 2.2 The capture loop polls it alongside the stdin-EOF and `--max-seconds` stops
- [x] 2.3 `record_default_input_live` returns `LiveOutcome { transcript, interrupted_by }`
- [x] 2.4 `deliver_and_settle`: keep the spill until the transcript write has returned Ok, and on any signal — a detached session outlives the terminal, so `finish().is_ok()` is not delivery (grok P2)
- [x] 2.5 `cli::record::run_live` exits `128 + signal` after writing the transcript

## 3. CLI

- [x] 3.1 `recordEngine` accepts 130/143 from a live run; `--out` still reports them as failures
- [x] 3.2 README names what survives an interruption

## 4. Tests

- [x] 4.1 An unfinished spill still decodes as a WAV holding the synced samples
- [x] 4.2 A finished spill holds every pushed sample
- [x] 4.3 `discard` removes the file
- [x] 4.4 Pruning drops stale spills, keeps fresh ones, and ignores files it did not write
- [x] 4.5 A raised SIGINT is recorded instead of killing the process, and leaves `SIG_DFL` behind
- [x] 4.7 The spill survives a transcript that could not be written; a delivered one takes it away; an interrupted one keeps it
- [x] 4.6 TS: `recordEngine` resolves on 130/143 for `--live`, rejects them for `--out`

## 5. Verification

- [x] 5.1 `bun test && bun run lint`
- [x] 5.2 `just rust-test`, `cargo fmt`, `cargo clippy --all-targets -- -D warnings`
- [x] 5.3 `cargo check --features coreml --no-default-features --all-targets`
- [x] 5.4 `just verify-darwin-full`
- [x] 5.5 Manual: local coreml build, dictate, Ctrl-C mid-sentence — transcript on stdout, exit 130, recovery WAV kept and transcribable; then a normal run leaving nothing behind
