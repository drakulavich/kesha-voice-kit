## MODIFIED Requirements

### Requirement: `--live` transcribes the microphone without writing a file

`kesha record --live` SHALL capture the default microphone and transcribe it through a streaming ASR session, printing the final transcript to stdout when recording stops. No WAV file SHALL be left behind by a session that ends normally. Progress and errors go to stderr so stdout carries the transcript and nothing else. `--quiet` SHALL keep the no-speech line.

Recording stops on the same conditions as capture-to-WAV (`--max-seconds` elapsed, or stdin EOF) and additionally on SIGINT or SIGTERM.

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
> the WAV path. `--quiet` keeps the no-speech line because it is the session's
> outcome, not progress. The relay's contract for a reader that leaves is the
> next requirement. The recovery WAV a session writes while it runs is the
> subject of "`--live` keeps recovery audio when the session does not end
> normally".*

## ADDED Requirements

### Requirement: An interrupted `--live` session still yields the transcript

The Engine SHALL catch SIGINT and SIGTERM during a live session, finish the streaming session, print the transcript of everything captured so far to stdout as a normal stop does, and exit `128 + signal` (130 for SIGINT, 143 for SIGTERM). The CLI SHALL treat those two exit codes from a live run as success and print no engine-failure message under the transcript. A signalled `--out` run is still a failure.

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

> *Technical Note — the handler is `record::interrupt` in `rust/src/record.rs`:
> `libc::signal` for both signals, with a handler that stores the number in an
> `AtomicI32` and re-arms the default disposition, so a second Ctrl-C kills a
> session whose `finish` has wedged. The capture loop polls it alongside the
> stdin-EOF and `--max-seconds` stops; `rust/src/cli/record.rs` exits
> `128 + signal` after writing stdout. CLI side: `SIGNALLED_LIVE_EXIT_CODES` in
> `src/engine.ts`, applied only when the target is live.*

### Requirement: `--live` keeps recovery audio when the session does not end normally

The Engine SHALL write the captured audio to a recovery WAV as it streams, refreshing its RIFF size fields as capture proceeds so a process killed outright leaves a readable WAV. It SHALL delete the file only after the transcript was written to stdout following a stop that saw no signal, and SHALL otherwise keep it and name its path on stderr. A session started without `--quiet` SHALL also name the path on stderr when it starts.

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

> *Technical Note — `record::spill::SpillWav` in `rust/src/record.rs` writes the
> same plain `WAVE_FORMAT_IEEE_FLOAT` mono layout as `--out`, sharing
> `wav_header_bytes`, and rewrites the RIFF/`fact`/`data` sizes every
> `SYNC_SAMPLES` (16 000, ~0.33 s at a 48 kHz device), which bounds what a
> `kill -9` costs. The guarantee covers process death, where the page cache
> stays coherent, not machine death: nothing here `fsync`s, so a power cut could
> persist the header ahead of the data it describes. Spilled samples are the
> mixed-to-mono, device-rate ones, taken before the resample to 16 kHz. The
> keep/delete decision is `record::deliver_and_settle`, which runs after the
> stdout write and reads its result. The start-of-session line is a progress
> event, which `--quiet` drops in `src/engine.ts::recordEngine`; the kept-file
> line is a warning.*

### Requirement: Recovery WAVs live under the Kesha cache and expire after seven days

Recovery WAVs SHALL live in `recordings/` under the Kesha cache, following `KESHA_CACHE_DIR`, and those older than seven days SHALL be pruned when a live session starts. A failure to create or write the recovery WAV SHALL be reported on stderr and SHALL NOT abort the session it exists to protect.

#### Scenario: an old recovery WAV is pruned

- GIVEN a recovery WAV from a session eight days ago is in `recordings/`
- WHEN Maks starts `kesha record --live`
- THEN that file is removed
- AND recovery WAVs younger than seven days stay

#### Scenario: the cache is not writable

- GIVEN the Kesha cache directory cannot be written
- WHEN Maks runs `kesha record --live`
- THEN stderr warns that this session has no recovery audio
- AND the session records and transcribes as usual

> *Technical Note — directory: `spill::recovery_dir`, which is
> `models::cache_dir().join("recordings")`; retention: `spill::RETENTION`, pruned
> by `spill::prune_stale_spills` in `open_recovery_spill`.*
