# Audio Recording Specification

## Purpose

`kesha record` captures microphone audio to a WAV file so Maks can record a
voice note or meeting directly from the command line, then immediately pipe it
into `kesha` for transcription. The recording is entirely local: the Engine
opens the default system microphone via CPAL, mixes all input channels to
mono, and writes an IEEE-float 32-bit WAV at the device's native sample rate.

## Non-Goals

- `kesha record` is macOS-only. Linux and Windows receive a clear
  `E_UNSUPPORTED_PLATFORM` error.
- Device selection is not supported; only the OS default input device is used.
- Live streaming of audio to stdout is not supported; the WAV is written when
  recording stops.
- No transcription or language detection is performed during recording;
  `kesha record` is a capture-only command.
- The output sample rate is whatever the device reports; no resampling is
  applied by the recorder itself.

## Requirements

### Requirement: --out is required

The CLI SHALL reject invocations that omit `--out` and exit 2 with a message
naming the missing flag. The exit 2 happens in the CLI before the Engine is
spawned.

#### Scenario: Ira forgets --out

- WHEN Ira runs `kesha record`
- THEN the CLI prints `kesha record requires --out <path>.` to stderr
- AND the process exits 2

#### Scenario: Maks records to a specific path

- GIVEN the microphone is available and recording is allowed by macOS
- WHEN Maks runs `kesha record --out ~/notes/standup.wav`
- THEN recording begins immediately and `standup.wav` is created when it stops
- AND the process exits 0

> *Technical Note — validation: `resolveRecordArgs` in
> `src/cli/record.ts` lines 18–38. Exit 2: `src/cli/record.ts` line 68.*

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

### Requirement: Output is a WAV file — IEEE-float 32-bit mono at native device rate

The Engine SHALL write the recording as a RIFF WAV file with format tag
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

### Requirement: Success message on stderr names recording details

When recording completes successfully, the Engine SHALL print a single line to
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

## Open Issues

- Device selection (`--device`) is not implemented; only the OS default input
  is used. Feature request tracked separately.
- The output sample rate is device-native (commonly 44100 Hz or 48000 Hz).
  The transcription pipeline resamples to 16 kHz internally; no explicit
  `--rate` flag exists on `kesha record`.
