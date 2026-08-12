# Audio Recording Specification

## Purpose

`kesha record` captures the microphone, in one of two modes. With `--out` it
writes a WAV file so Maks can record a voice note or meeting and pipe it into
`kesha` for Transcription. With `--live` it transcribes as it captures and
prints the transcript instead, skipping the file entirely. Both are entirely
local: the Engine opens the default system microphone via CPAL and mixes all
input channels to mono.

## Non-Goals

- `kesha record` is macOS-only. Linux and Windows receive a clear
  `E_UNSUPPORTED_PLATFORM` error. `--live` narrows further — it needs a CoreML
  Engine on Apple Silicon.
- Device selection is not supported; only the OS default input device is used.
- Raw audio is never streamed to stdout. `--out` writes the WAV when recording
  stops; `--live` puts a transcript on stdout, not samples.
- `--live` emits no partial transcripts. The streaming ASR session consumes
  audio incrementally, but the transcript is printed once, when recording stops.
- Language detection is not performed in either mode.
- With `--out`, the sample rate is whatever the device reports and the recorder
  applies no resampling. `--live` resamples to 16 kHz in flight, because that is
  what the ASR model consumes.
## Requirements
### Requirement: `--live` and `--out` are mutually exclusive, and one is required

The CLI SHALL reject an invocation that passes both `--live` and `--out`, and SHALL reject one that passes neither, exiting 2 in both cases before the Engine is spawned. `--out` alone and `--live` alone are each complete invocations.

#### Scenario: Ira passes both flags

- WHEN Ira runs `kesha record --live --out note.wav`
- THEN the CLI prints an error stating the two flags cannot be combined
- AND the process exits 2 without spawning the Engine

#### Scenario: Maks passes neither

- WHEN Maks runs `kesha record`
- THEN the CLI prints `kesha record requires --out <path> (or --live).`
- AND the process exits 2

#### Scenario: Maks records to a specific path

- GIVEN the microphone is available and recording is allowed by macOS
- WHEN Maks runs `kesha record --out ~/notes/standup.wav`
- THEN recording begins immediately and `standup.wav` is created when it stops
- AND the process exits 0

#### Scenario: `--live` alone is accepted

- WHEN Maks runs `kesha record --live --max-seconds 30`
- THEN argument resolution succeeds and the Engine is spawned in live mode

> *Technical Note — `resolveRecordArgs` in `src/cli/record.ts` returns a
> discriminated result carrying either `out` or `live`, so the two cannot both
> be set downstream.*

### Requirement: `--live` transcribes the microphone without writing a file

`kesha record --live` SHALL capture the default microphone and transcribe it through a streaming ASR session, printing the final transcript to stdout when recording stops. No WAV file SHALL be written. Progress and errors go to stderr so stdout carries the transcript and nothing else.

Recording stops on the same conditions as capture-to-WAV: `--max-seconds` elapsed, or stdin EOF.

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
> session's transcript for any input, including silence. Every FluidAudio call
> is wrapped in `fluid_stdout::with_silenced_stdout` (#259). The live capture
> loop is `record_default_input_live` in `rust/src/record.rs`, sharing
> `build_input_stream`, `mix_frame_to_mono` and `spawn_stdin_stop_thread` with
> the WAV path.*

### Requirement: `--live` requires an Engine that advertises `record.live`

The CLI SHALL check the Engine's Capabilities for the `record.live` feature flag before spawning, and SHALL refuse `--live` with a message naming the platform requirement and pointing at the capture-then-transcribe alternative when the flag is absent. The flag SHALL NOT be forwarded to an Engine that does not advertise it.

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
> `transcribe.diarize` gate. The Engine-side `cfg` gate is the second line of
> defence: a build without the streaming session rejects `--live` with
> `error [E_UNSUPPORTED_PLATFORM]` and exit 1, naming the two-step alternative —
> the same shape `record` already uses on Linux.*

### Requirement: --max-seconds defaults to 120 and must be 1–3600

The CLI SHALL default `--max-seconds` to 120 when omitted. It SHALL reject
values that are not positive integers in the range 1–3600 and exit 2 with a
message stating the valid range. The Engine stops recording when the elapsed
time reaches `max-seconds`, even if stdin remains open.

#### Scenario: Default recording stops at 120 s

- GIVEN no `--max-seconds` is passed
- WHEN Maks runs `kesha record --out note.wav` and lets it run
- THEN recording stops automatically after 120 seconds
- AND `note.wav` is written and the process exits 0

#### Scenario: Value out of range is rejected

- WHEN Ira runs `kesha record --out out.wav --max-seconds 9999`
- THEN the CLI prints an error stating `--max-seconds must be an integer
  between 1 and 3600.`
- AND the process exits 2 without spawning the Engine

#### Scenario: Non-integer value is rejected

- WHEN Maks runs `kesha record --out out.wav --max-seconds 30.5`
- THEN the CLI exits 2 with a message about the valid range

> *Technical Note — constants: `DEFAULT_MAX_SECONDS = 120`,
> `MAX_RECORD_SECONDS = 3600`. Source: `src/cli/record.ts` lines 15–16.
> Integer check: `src/cli/record.ts` line 30 (`Number.isInteger`).*

### Requirement: macOS-only at runtime

The Engine SHALL return `E_UNSUPPORTED_PLATFORM` immediately when
`record` is invoked on a non-macOS platform. The CLI surfaces this as a
runtime exit 1.

#### Scenario: Ira runs kesha record on Linux CI

- GIVEN `kesha-engine` is the Linux ONNX build
- WHEN Ira runs `kesha record --out out.wav`
- THEN the Engine reports that microphone recording is supported on macOS only
- AND the process exits 1

> *Technical Note — non-macOS gate: `rust/src/record.rs` lines 48–56
> (`#[cfg(not(target_os = "macos"))]` returns `E_UNSUPPORTED_PLATFORM` with
> message `"microphone recording is currently supported on macOS only"`).*

### Requirement: Records the default microphone, mixes to mono

The Engine SHALL open the OS default input device via CPAL and accept any
device sample format (F32, I16, U16). Multi-channel input SHALL be mixed down
to mono by averaging all channels in each frame. The resulting mono samples
are clamped to `[-1.0, 1.0]` before writing.

#### Scenario: Maks uses a stereo USB microphone

- GIVEN the default input device reports 2 channels
- WHEN Maks runs `kesha record --out stereo-mic.wav --max-seconds 5`
- THEN `stereo-mic.wav` is a valid mono WAV (1 channel) at the device's native
  sample rate
- AND the process exits 0

#### Scenario: No microphone is available

- GIVEN no default input device exists on the system
- WHEN Maks runs `kesha record --out out.wav`
- THEN the Engine reports `no default microphone input device found`
- AND the process exits 1

> *Technical Note — channel mix: `mix_frame_to_mono` in `rust/src/record.rs`
> line 207 (frame average). Clamp: `rust/src/record.rs` line 110
> (`.clamp(-1.0, 1.0)`). Sample format dispatch: `rust/src/record.rs`
> lines 83–87 (F32/I16/U16 branches).*

### Requirement: Recording stops on stdin EOF or max-seconds elapsed

The Engine SHALL stop recording when either `--max-seconds` elapsed time is
reached or stdin reaches EOF (pipe closed by the caller), whichever comes
first. If stdin is a terminal, the EOF stop is not available; only
`--max-seconds` applies.

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

### Requirement: `--out` produces a WAV file — IEEE-float 32-bit mono at native device rate

With `--out`, the Engine SHALL write the recording as a RIFF WAV file with format tag
`0x0003` (IEEE float), 1 channel, 32 bits per sample, at the native device
sample rate. The file SHALL include a `fact` chunk as required by the
IEEE-float WAV format. Parent directories are created if they do not exist.

#### Scenario: Output file is a valid IEEE-float WAV

- GIVEN recording completes normally
- WHEN Maks opens `note.wav` in any standard audio tool (e.g. Audacity, sox)
- THEN the tool reads it as a 32-bit float mono WAV at the device sample rate

#### Scenario: Output directory does not exist

- WHEN Maks runs `kesha record --out /tmp/new-dir/note.wav`
  and `/tmp/new-dir` does not exist
- THEN the Engine creates `/tmp/new-dir/` and writes `note.wav` there
- AND the process exits 0

> *Technical Note — WAV format tag: `FORMAT_IEEE_FLOAT = 0x0003`
> (`rust/src/record.rs` line 23). The writer uses plain `WAVE_FORMAT_IEEE_FLOAT`
> (not `WAVE_FORMAT_EXTENSIBLE`) to avoid CoreAudio interpreting a stereo
> layout that does not apply to mono files. `fact` chunk is always written.
> Source: `write_plain_mono_float_wav` in `rust/src/record.rs` lines 234–276.*

### Requirement: `--out` prints a success message on stderr naming recording details

When a capture-to-WAV recording completes successfully, the Engine SHALL print a single line to
stderr of the form:

```
Recorded <path> (<sample_rate> Hz, <channels> channel, <frames> frames)
```

Stdout remains empty so the caller can detect the silent completion without
parsing.

#### Scenario: Maks reads the confirmation

- GIVEN `kesha record --out note.wav --max-seconds 5` completes normally
- THEN stderr contains exactly one line matching
  `Recorded note.wav (44100 Hz, 1 channel, <N> frames)`
- AND stdout is empty
- AND the process exits 0

> *Technical Note — success message: `rust/src/cli/record.rs` lines 9–14.
> Pluralization: `"channel"` (singular) when `channels == 1`.*

### Requirement: Recording without an installed engine fails with an install hint
`kesha record` SHALL check that the engine binary is installed before spawning it. When the engine is missing, the CLI SHALL print a human-readable error naming the missing backend and the exact install command, and exit 1. A raw runtime stack trace MUST never be the user-facing output for this condition.

#### Scenario: record before kesha install
- **WHEN** a user runs `kesha record --out x.wav` and the engine binary is not installed
- **THEN** stderr contains "No recording backend is installed" followed by the install hint, the process exits 1, and no stack trace is printed

## Open Issues

- Device selection (`--device`) is not implemented; only the OS default input
  is used. Feature request tracked separately.
- With `--out` the sample rate is device-native (commonly 44100 Hz or 48000 Hz).
  The transcription pipeline resamples to 16 kHz internally; no explicit
  `--rate` flag exists on `kesha record`.
- `--live` is unreleased. It is on `main` only — no release tag contains #757,
  and the Pinned Engine version is older — so nothing a user installs today
  advertises `record.live`. Anything adopting it, the Raycast extension
  included (#947), is blocked on a CLI + Engine release and needs the
  capability probe regardless, for every older CLI in the wild.
- An interrupted `--live` session yields nothing: there is no intermediate
  artifact, so a killed process loses the audio and the transcript together.
  The `--out` path at least leaves the WAV. Tracked as #962.
