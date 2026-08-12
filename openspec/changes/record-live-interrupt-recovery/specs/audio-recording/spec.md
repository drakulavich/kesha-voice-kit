## Open Issues

- The baseline Open Issue *"An interrupted `--live` session yields nothing:
  there is no intermediate artifact, so a killed process loses the audio and
  the transcript together"* is what this change answers, and the archive step
  must delete it rather than leave it beside the requirements below.
- The CLI force-kills the Engine one second after forwarding a signal
  (`FORCE_KILL_GRACE_MS` in `src/process-tree.ts`). Finishing a streaming
  session is well inside that on an M-series Mac, but the budget belongs to the
  process-tree work in #939, not here. If it is ever exceeded the transcript is
  lost and the recovery WAV is what remains — the degradation this change is
  built around, not a new failure.

## MODIFIED Requirements

### Requirement: `--live` transcribes the microphone without writing a file

`kesha record --live` SHALL capture the default microphone and transcribe it through a streaming ASR session, printing the final transcript to stdout when recording stops. No WAV file SHALL be left behind by a session that ends normally. Progress and errors go to stderr so stdout carries the transcript and nothing else.

Recording stops on the same conditions as capture-to-WAV — `--max-seconds` elapsed, or stdin EOF — and additionally on SIGINT or SIGTERM.

#### Scenario: Maks dictates a note straight to text

- GIVEN a CoreML Engine on darwin-arm64 with the ASR model cached
- WHEN Maks runs `kesha record --live --max-seconds 10` and speaks a sentence
- THEN stdout contains the transcript of what he said and nothing else
- AND no file remains once the transcript has printed
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

## ADDED Requirements

### Requirement: An interrupted `--live` session still yields the transcript

The Engine SHALL catch SIGINT and SIGTERM during a live session, stop capture,
drain and finish the streaming session, and print the transcript of everything
captured up to that moment to stdout exactly as a normal stop does. It SHALL
then exit `128 + signal` — 130 for SIGINT, 143 for SIGTERM — so a caller can
tell a cancellation from a run that reached its end.

The CLI SHALL treat those two exit codes from a live run as success, because
the transcript arrived intact; it SHALL NOT print an engine-failure message
under it. A signalled `--out` run has no such handler and is still reported as
a failure.

#### Scenario: Maks hits Ctrl-C after four minutes of dictation

- GIVEN Maks is part way through `kesha record --live --max-seconds 600`
- WHEN he presses Ctrl-C
- THEN stdout carries the transcript of what he said before pressing it
- AND no engine-failure message is printed under the transcript
- AND the process exits 130

#### Scenario: Raycast cancels the session

- GIVEN the Raycast extension (#947) cancels a running live session with SIGTERM
- THEN the transcript captured so far is on stdout
- AND the process exits 143

> *Technical Note — the handler is `record::interrupt`: `libc::signal` for both
> signals with a handler that does nothing but store the number in an
> `AtomicI32`, which is the async-signal-safe subset. The capture loop polls it
> alongside the stdin-EOF and `--max-seconds` stops; `cli::record::run_live`
> reads it again after writing stdout and exits `128 + signal`. CLI side:
> `SIGNALLED_LIVE_EXIT_CODES` in `src/engine.ts`.*

### Requirement: `--live` keeps recovery audio when the session does not end normally

The Engine SHALL write the captured microphone audio to a recovery WAV as it
streams, so that a session which cannot print — SIGKILL, a panic, a crash —
still leaves audio to transcribe. The file SHALL be readable while it is being
written: its RIFF size fields are refreshed as capture proceeds, so a process
killed outright leaves a valid WAV rather than a header claiming no samples.
At most the audio since the last refresh may be missing.

The recovery WAV SHALL be deleted only once the transcript has been **delivered**
— the write to stdout returned successfully — after a stop that saw no signal.
It SHALL be kept, with its path named on stderr, whenever the session was
interrupted, transcription failed, or the transcript could not be written. Its
path SHALL be printed on stderr when the session starts, so it is discoverable
even by a user whose process was killed without warning.

Recovery WAVs SHALL live under the Kesha cache (`recordings/`), following
`KESHA_CACHE_DIR`, and those older than seven days SHALL be pruned when a live
session starts. A failure to create or write the recovery WAV SHALL be reported
on stderr and SHALL NOT abort the session it exists to protect.

#### Scenario: Ira's terminal window is closed mid-dictation

- GIVEN Ira is dictating into `kesha record --live` and the process is killed
  outright, with no chance to print
- WHEN she looks for the audio afterwards
- THEN the recovery WAV named on stderr at session start is a readable mono WAV
  holding what she said
- AND `kesha <that path>` transcribes it

#### Scenario: the terminal is gone by the time the transcript is ready

- GIVEN Maks starts `kesha record --live` and closes the terminal window, and
  the Engine — spawned detached — keeps recording to `--max-seconds` because no
  SIGHUP ever reaches it
- WHEN the session finishes and the write to the closed terminal fails
- THEN the recovery WAV is kept rather than deleted, because the transcript
  never reached anyone
- AND the same holds when a pipe consumer exits before the recording stops

#### Scenario: a normal session leaves nothing behind

- GIVEN `kesha record --live --max-seconds 5` runs to its own end
- THEN the transcript is on stdout
- AND the recovery WAV has been removed

#### Scenario: the cache is not writable

- GIVEN the Kesha cache directory cannot be written
- WHEN Maks runs `kesha record --live`
- THEN stderr warns that this session has no recovery audio
- AND the session records and transcribes as usual

> *Technical Note — `record::spill::SpillWav` in `rust/src/record.rs` writes the
> same plain `WAVE_FORMAT_IEEE_FLOAT` mono layout as `--out`, sharing
> `wav_header_bytes`, and rewrites the RIFF/`fact`/`data` sizes every
> `SYNC_SAMPLES` (16 000, ~0.33 s at a 48 kHz device) — which is the bound on
> what a `kill -9` costs. The guarantee covers process death, where the page
> cache stays coherent, not machine death: nothing here `fsync`s, so a power cut
> could persist the header ahead of the data it describes.
> Spilled samples are the mixed-to-mono, device-rate ones, taken before the
> session's resample to 16 kHz, so the recovery audio is full fidelity.
> Directory: `models::cache_dir().join("recordings")`; retention: 7 days.
> The keep/delete decision is `record::deliver_and_settle`, which runs *after*
> the stdout write and reads its result.*
