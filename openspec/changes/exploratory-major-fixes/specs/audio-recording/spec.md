## MODIFIED Requirements

### Requirement: `--live` transcribes the microphone without writing a file

`kesha record --live` SHALL capture the default microphone and transcribe it through a streaming ASR session, printing the final transcript to stdout when recording stops. No WAV file SHALL be written. Progress and errors go to stderr so stdout carries the transcript and nothing else. The no-speech line is the session's outcome, not progress: `--quiet` SHALL keep it.

Recording stops on the same conditions as capture-to-WAV: `--max-seconds` elapsed, or stdin EOF. The CLI's relay adds a contract of its own for the reader of stdout: when a write to stdout fails because the reader closed the pipe, the relay SHALL write nothing further, SHALL keep draining the Engine's stdout so the Engine never blocks, SHALL stop the Engine once rather than let it hold the microphone until `--max-seconds`, and SHALL judge the Engine's exit exactly as it judges any other live stop — the clean interrupt status is success, an error event is a failure. The shipped Engine delivers the transcript in one write after recording has stopped, so no write can fail before the stop and this contract has no observable effect today; it binds the moment the live session streams partial lines.

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

#### Scenario: Sona takes only the first line of a streaming transcript

- GIVEN an Engine that streams partial transcript lines to stdout as it recognises them (none ships today — the live session delivers once, at the end)
- AND Sona runs `kesha record --live | head -1`
- WHEN `head` prints the first line and exits, closing the pipe
- THEN the CLI stops the Engine at once instead of recording until `--max-seconds`
- AND the process exits 0, and the stop adds no message of its own to stderr — the listening line and the ticker printed before the reader left are the only progress; the reader leaving is not a failure, and nobody is there to tell

#### Scenario: nothing was said

- GIVEN Maks runs `kesha record --live --max-seconds 5` and stays silent
- THEN stdout is empty — not a blank line
- AND stderr says no speech was detected
- AND the process exits 0 rather than reporting a failure

#### Scenario: nothing was said, quietly

- GIVEN Maks runs `kesha record -q --live --max-seconds 5` and stays silent
- THEN stdout is empty
- AND stderr still says no speech was detected, with no listening line or ticker before it
- AND the process exits 0

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

### Requirement: `--out` prints a success message on stderr naming recording details

When a capture-to-WAV recording completes successfully, the Engine SHALL print a single line to
stderr of the form:

```
Recorded <path> (<sample_rate> Hz, <channels> channel, <frames> frames)
```

Stdout remains empty so the caller can detect the silent completion without
parsing. The line is the recording's outcome, not progress: `--quiet` SHALL
keep it while dropping the listening line and the elapsed-second ticker.

#### Scenario: Maks reads the confirmation

- GIVEN `kesha record --out note.wav --max-seconds 5` completes normally
- THEN stderr contains exactly one line matching
  `Recorded note.wav (44100 Hz, 1 channel, <N> frames)`
- AND stdout is empty
- AND the process exits 0

#### Scenario: Ira scripts a quiet recording

- GIVEN `kesha record -q --out note.wav --max-seconds 5` completes normally
- THEN stderr contains the `Recorded note.wav (...)` line and nothing else
- AND stdout is empty
- AND the process exits 0

> *Technical Note — success message: `rust/src/cli/record.rs` lines 9–14.
> Pluralization: `"channel"` (singular) when `channels == 1`.*
