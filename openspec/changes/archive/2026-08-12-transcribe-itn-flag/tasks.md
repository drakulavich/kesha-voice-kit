## 1. Engine: the pass

- [x] 1.1 Pin `text-processing-rs` by git rev in `rust/Cargo.toml`, default features only (D1)
- [x] 1.2 Add `rust/src/transcribe/itn.rs`: normalize one `TranscriptionOutput` per Segment, rebuild `text` via `join_segment_texts`, normalize `text` directly when there are no Segments (D2)
- [x] 1.3 Add `TRANSCRIBE_ITN_FEATURE` next to `TRANSCRIBE_SEGMENTS_FEATURE`, and an `itn` field on `TranscribeOptions` + its builder method (D3)
- [x] 1.4 Call the pass last in `transcribe_with_options`, after the Diarization merge (D2)
- [x] 1.5 Advertise `transcribe.itn` unconditionally in `capabilities.rs` (D3)
- [x] 1.6 `--itn` on the Engine's `transcribe` subcommand, threaded through `cli/transcribe.rs`

## 2. CLI: the flag and its gate

- [x] 2.1 Mirror `TRANSCRIBE_ITN_FEATURE` in `src/engine.ts`; forward `--itn` on both the text and `--json` Engine invocations
- [x] 2.2 Check the capability before spawning, on both Transcription paths, with the upgrade action in the message (D3)
- [x] 2.3 `--itn` on the `kesha` transcribe command, plumbed through `processFile`

## 3. Tests

- [x] 3.1 Rust: the pass rewrites English number words and leaves Russian byte-identical (D4)
- [x] 3.2 Rust: Segment `start`/`end` and Segment count survive the pass; `text` equals the join of Segment texts (D2)
- [x] 3.3 Rust: no Segments → transcript normalized directly; empty/whitespace input is not corrupted
- [x] 3.4 Rust: `transcribe.itn` present in Capabilities JSON on every feature set
- [x] 3.5 TS: `--itn` against an Engine lacking the capability fails with the upgrade action, on both the text and `--json` paths
- [x] 3.6 TS: `--itn` forwards to the Engine when the capability is present

## 4. Verification

- [x] 4.1 `bun test && bunx tsc --noEmit`
- [x] 4.2 `make rust-test`, `cargo fmt`, `cargo clippy --all-targets -- -D warnings`
- [x] 4.3 `cargo check --features coreml --no-default-features`
- [x] 4.4 Real en benchmark fixture through a coreml Engine build, `--itn` on and off, transcripts recorded
- [x] 4.5 Real ru benchmark fixture with `--itn`, result recorded
- [x] 4.6 `--json --timestamps --itn` output parses and round-trips to `TranscribeResult[]`
