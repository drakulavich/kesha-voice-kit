## MODIFIED Requirements

### Requirement: `--live` transcribes the microphone without writing a file

`kesha record --live` SHALL capture the default microphone and transcribe it through a streaming ASR session, printing the final transcript to stdout when recording stops. No WAV file SHALL be written. Progress and errors go to stderr so stdout carries the transcript and nothing else.

Recording stops on the same conditions as capture-to-WAV — `--max-seconds` elapsed, or stdin EOF — and on one more: when the process reading stdout closes it, the CLI SHALL stop the Engine rather than hold the microphone until `--max-seconds`. The relay SHALL keep draining the Engine's stdout so the Engine never blocks, SHALL write nothing further, and SHALL judge the Engine's exit exactly as it judges any other live stop: the clean interrupt status is success, an error event is a failure.

#### Scenario: Maks dictates a note straight to text

- GIVEN a CoreML Engine on darwin-arm64 with the ASR model cached
- WHEN Maks runs `kesha record --live --max-seconds 10` and speaks a sentence
- THEN stdout contains the transcript of what he said and nothing else
- AND no file is created
- AND the process exits 0

#### Scenario: Sona pipes the transcript into another tool

- GIVEN Sona runs `kesha record --live --max-seconds 5 | wc -w`
- WHEN stdin EOF stops the recording
- THEN the word count reflects only the transcript
- AND no progress text has leaked into the pipe

#### Scenario: Sona takes only the first line

- GIVEN Sona runs `kesha record --live | head -1`
- WHEN `head` prints the first transcript line and exits, closing the pipe
- THEN the CLI stops the Engine at once instead of recording until `--max-seconds`
- AND the process exits 0 with nothing on stderr — the reader leaving is not a failure, and nobody is there to tell

#### Scenario: nothing was said

- GIVEN Maks runs `kesha record --live --max-seconds 5` and stays silent
- THEN stdout is empty — not a blank line
- AND stderr says no speech was detected
- AND the process exits 0 rather than reporting a failure

> *Technical Note — the streaming session is `StreamingAsrSession` in
> `rust/src/streaming_asr.rs`, compiled only under
> `all(feature = "coreml", target_os = "macos")`. Its `finish` consumes `self`
> and `start` re-runs `init_streaming_asr()`, because `SlidingWindowAsrManager`
> does not reset between sessions and a reused manager returns the previous
> session's transcript for any input, including silence. Every FluidAudio call
> is wrapped in `fluid_stdout::with_silenced_stdout` (#259). The live capture
> loop is `record_default_input_live` in `rust/src/record.rs`, sharing
> `build_input_stream`, `mix_frame_to_mono` and `spawn_stdin_stop_thread` with
> the WAV path.*

### Requirement: Recording stops on stdin EOF or max-seconds elapsed

The Engine SHALL stop recording when either `--max-seconds` elapsed time is
reached or stdin reaches EOF (pipe closed by the caller), whichever comes
first. If stdin is a terminal, the EOF stop is not available; only
`--max-seconds` applies. Under `--live` the CLI adds a third stop: the reader of
its stdout closing the pipe, on which the CLI sends the Engine one `SIGTERM`.

#### Scenario: Sona stops recording by closing the pipe

- GIVEN Sona's script opens `kesha record --out captured.wav` and closes stdin
  after 3 s
- WHEN stdin EOF is detected
- THEN the Engine stops recording immediately and writes `captured.wav`
- AND the process exits 0

#### Scenario: Interactive terminal relies on max-seconds

- GIVEN Maks runs `kesha record --out note.wav --max-seconds 10` in a terminal
- WHEN 10 seconds elapse
- THEN recording stops automatically and `note.wav` is written

> *Technical Note — stdin EOF stop: `spawn_stdin_stop_thread` in
> `rust/src/record.rs` lines 131–139; the thread is only spawned when stdin is
> not a terminal (`!io::stdin().is_terminal()`). Max-seconds check:
> `rust/src/record.rs` lines 96 and 106.*
