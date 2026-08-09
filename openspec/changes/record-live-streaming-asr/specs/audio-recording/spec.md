## Open Issues

- Two of the baseline `audio-recording` Non-Goals are superseded by this change
  and must be rewritten when it is archived: *"No transcription or language
  detection is performed during recording; `kesha record` is a capture-only
  command"* is now false on a CoreML Engine, and *"The output sample rate is
  whatever the device reports; no resampling is applied by the recorder itself"*
  holds for `--out` but not for `--live`, which resamples to 16 kHz in flight.
  Neither is restated as a requirement here, so nothing in this delta silently
  contradicts them — but the archive step must not just append.

## ADDED Requirements

### Requirement: `--live` transcribes the microphone without writing a file

`kesha record --live` SHALL capture the default microphone and transcribe it
through a streaming ASR session, printing the final transcript to stdout when
recording stops. No WAV file SHALL be written. Progress and errors go to
stderr so stdout carries the transcript and nothing else.

Recording stops on the same conditions as capture-to-WAV: `--max-seconds`
elapsed, or stdin EOF.

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
> session's transcript for any input, including silence (see design.md D0).
> Every FluidAudio call is wrapped in `fluid_stdout::with_silenced_stdout`
> (#259). The live capture loop is `record_default_input_live` in
> `rust/src/record.rs`, sharing `build_input_stream`, `mix_frame_to_mono` and
> `spawn_stdin_stop_thread` with the WAV path.*

### Requirement: `--live` and `--out` are mutually exclusive

The CLI SHALL reject an invocation that passes both `--live` and `--out`, and
SHALL exit 2 before the Engine is spawned. When neither is passed the existing
"`--out` is required" error applies. `--live` alone is a complete invocation.

#### Scenario: Ira passes both flags

- WHEN Ira runs `kesha record --live --out note.wav`
- THEN the CLI prints an error stating the two flags cannot be combined
- AND the process exits 2 without spawning the Engine

#### Scenario: Maks passes neither

- WHEN Maks runs `kesha record`
- THEN the CLI prints `kesha record requires --out <path> (or --live).`
- AND the process exits 2

#### Scenario: `--live` alone is accepted

- WHEN Maks runs `kesha record --live --max-seconds 30`
- THEN argument resolution succeeds and the Engine is spawned in live mode

> *Technical Note — resolution: `resolveRecordArgs` in `src/cli/record.ts`
> returns a discriminated result carrying either `out` or `live`, so the two
> cannot both be set downstream.*

### Requirement: `--live` requires an Engine that advertises `record.live`

The CLI SHALL check the Engine's Capabilities for the `record.live` feature
flag before spawning, and SHALL refuse `--live` with a message naming the
platform requirement and pointing at the capture-then-transcribe alternative
when the flag is absent. The flag SHALL NOT be forwarded to an Engine that does
not advertise it.

#### Scenario: Ira runs `--live` against a Linux ONNX Engine

- GIVEN the installed Engine does not advertise `record.live`
- WHEN Ira runs `kesha record --live`
- THEN the CLI reports that live transcription requires a CoreML Engine on
  Apple Silicon, and names `kesha record --out … && kesha …` as the way to get
  a transcript on this platform
- AND the process exits 1 without spawning the Engine

#### Scenario: capabilities cannot be read

- GIVEN the Engine is installed but `--capabilities-json` fails
- WHEN Maks runs `kesha record --live`
- THEN the CLI refuses rather than forwarding `--live` on the assumption that
  it is supported

> *Technical Note — flag: `RECORD_LIVE_FEATURE = "record.live"` in
> `src/engine.ts`, checked by `preflightRecordLive`. Mirrors the
> `transcribe.diarize` gate at `src/engine.ts:196`. The Engine-side `cfg` gate
> is the second line of defence: a build without the streaming session rejects
> `--live` with `error [E_UNSUPPORTED_PLATFORM]` and exit 1, naming the two-step
> alternative — the same shape `record` already uses on Linux.*
