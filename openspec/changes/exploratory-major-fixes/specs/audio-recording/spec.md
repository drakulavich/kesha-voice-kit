## ADDED Requirements

### Requirement: An `--out` path that cannot take the WAV is refused before the microphone opens

The Engine SHALL open the `--out` path before it opens the microphone, and SHALL refuse a path it cannot write — a directory, a symlink to one, a location this user cannot write into — with the Error code `E_INVALID_ARG`, a message naming `--out`, the path and the operating system's reason, and exit 1, without recording anything.

#### Scenario: Maks passes a directory as --out

- GIVEN `~/recordings` is a directory
- WHEN Maks runs `kesha record --out ~/recordings --max-seconds 30`
- THEN the Engine reports `E_INVALID_ARG` naming `~/recordings` and `Is a directory`
- AND no recording runs first
- AND the process exits 1

#### Scenario: Ira records into a directory she cannot write

- GIVEN `/srv/locked` exists and Ira has no write permission on it
- WHEN Ira runs `kesha record --out /srv/locked/note.wav`
- THEN the Engine reports `E_INVALID_ARG` naming the path and `Permission denied`
- AND the process exits 1

#### Scenario: A writable path records as before

- WHEN Maks runs `kesha record --out ~/notes/standup.wav` and stops it
- THEN the WAV is written there and the success line reports it

> *Technical Note — `rust/src/record.rs::create_wav_output` runs first in
> `record_default_input_to_wav`; a capture failure after it removes the empty
> file it created.*

### Requirement: A recording whose parent process exits stops within about a second

The Engine SHALL stop a `kesha record` capture within about a second of losing the process that started it — detected by its parent pid becoming 1 or changing from the one it started with — closing the microphone, removing any partially written file, and exiting non-zero, even when no signal reached it and its standard input stayed open.

#### Scenario: Ira's CLI is force-killed mid-recording

- GIVEN Ira started `kesha record --out note.wav` and the CLI is killed with SIGKILL from an interactive terminal
- WHEN about a second passes
- THEN the Engine has closed the microphone and exited non-zero
- AND `note.wav` was not left behind

#### Scenario: A recording whose caller is alive runs to its limit

- GIVEN Maks runs `kesha record --out note.wav --max-seconds 5` and lets it run
- WHEN the five seconds elapse with the caller still present
- THEN the recording completes and the WAV is written

> *Technical Note — `rust/src/record.rs::spawn_parent_watch_thread` polls `getppid`
> every 250 ms and sends `Stop::ParentExited`, on which `capture_default_input_mono`
> returns `ParentExited`; `rust/src/cli/record.rs` maps that to exit 129.*
