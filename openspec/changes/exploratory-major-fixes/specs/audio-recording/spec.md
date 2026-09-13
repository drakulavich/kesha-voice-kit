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
