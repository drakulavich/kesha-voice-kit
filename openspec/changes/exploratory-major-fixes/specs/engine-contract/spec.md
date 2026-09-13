## ADDED Requirements

### Requirement: A panic is reported through the Event stream

The Engine SHALL report a panic it did not expect as one `error` event with the Error code `E_INTERNAL` naming the panic and its location, and SHALL then exit 1; the runtime's own panic prose and its `RUST_BACKTRACE` hint SHALL NOT reach stderr.

#### Scenario: An unexpected panic during a command

- GIVEN a command hits a panic no code path anticipated
- WHEN the Engine unwinds
- THEN stderr carries one `error` event whose `code` is `E_INTERNAL` and whose message starts with `engine panicked:`
- AND the process exits 1

#### Scenario: A panic the Engine anticipates and codes

- GIVEN a code path guards a known panic and reports it under its own Error code
- WHEN that panic fires
- THEN only the coded event is emitted, never a second `E_INTERNAL` for the same failure

> *Technical Note — `rust/src/errors.rs::install_panic_hook` is installed first thing in
> `rust/src/main.rs`, which also catches the unwind to exit 1; `catch_panic` marks the
> thread so the hook skips a panic the caller reports itself.*

### Requirement: Transcription reports progress while it runs

The Engine's `transcribe` command SHALL emit protocol-4 `progress` events while it works — at minimum when the speech model is loading, and once per speech segment as it is transcribed — so a caller that wired `TranscribeOptions.onProgressLine` sees movement during a plain transcribe rather than a callback that never fires until the run is over. These are in addition to the existing `debug` events, which are unchanged.

#### Scenario: Sona transcribes a plain voice note with a spinner

- GIVEN Sona calls `transcribe` with an `onProgressLine` callback and the ASR model is installed
- WHEN a plain (non-diarized) transcription runs
- THEN her callback receives at least one `progress` event before the transcript resolves

#### Scenario: A VAD-segmented transcription reports each segment

- GIVEN a file long enough to be split into speech segments
- WHEN it is transcribed
- THEN a `progress` event is emitted for each segment as it is processed

> *Technical Note — `rust/src/transcribe/mod.rs::create_timed_backend` emits the model-load
> event on every backend-loading path (plain, chunked, VAD), and `build_vad_output_segments`
> emits `transcribing segment N of M`; both go through `protocol::events::progress`.*
