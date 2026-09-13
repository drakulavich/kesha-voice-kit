## MODIFIED Requirements

### Requirement: Conflicting or incomplete flag combinations are rejected

The CLI SHALL validate flag combinations before starting the Engine and exit 2
with one stderr line of the form `error [E_INVALID_ARG]: <message>` when the
request is contradictory.

The rejected combinations are: `--json` with `--toon`; `--format transcript`
combined with `--json` or `--toon`; `--timestamps` or `--speakers` without
`--json`/`--toon`; `--include-errors` without `--json`/`--toon`; `--vad` with
`--no-vad`; an unknown `--format` value.

#### Scenario: Both JSON and TOON requested

- WHEN Ira runs `kesha --json --toon call.ogg`
- THEN stderr contains `error [E_INVALID_ARG]: --json and --toon are mutually exclusive`
- AND the process exits 2 without spawning the Engine

#### Scenario: Timestamps in plain-text mode

- WHEN Maks runs `kesha --timestamps call.ogg`
- THEN the CLI exits 2 telling him `--timestamps` requires `--json` or `--toon`, on a line carrying the `E_INVALID_ARG` code

### Requirement: Transcribe a single audio file to plain text

The CLI SHALL transcribe a given audio file and print the transcript to stdout
followed by a newline, keeping all progress and error output on stderr so the
transcript can be piped.

Supported containers/codecs are those the Engine's decoder handles (MP3, WAV,
FLAC, AAC, OGG/Vorbis, Opus, AIFF, …); audio is mixed to mono and resampled to
16 kHz internally.

#### Scenario: Ira pipes a transcript in CI

- GIVEN the Engine and ASR models are installed
- WHEN Ira runs `kesha standup.ogg > transcript.txt`
- THEN `transcript.txt` contains only the transcript text and a trailing newline
- AND the spinner/progress output (if any) went to stderr
- AND the process exits 0

#### Scenario: Input file does not exist

- WHEN Ira runs `kesha missing.ogg`
- THEN an error naming the missing file is printed to stderr
- AND the process exits 1

#### Scenario: File exists but is not decodable audio

- WHEN Maks runs `kesha notes.txt` on a text file
- THEN the Engine reports an unsupported-format error for that path on stderr
- AND the process exits 1

#### Scenario: No input files given

- WHEN Ira runs `kesha` with no arguments, or `kesha --json` with no files
- THEN stderr carries `error [E_INVALID_ARG]: no input file` followed by the usage summary
- AND stdout is empty
- AND the process exits 2

> *Technical Note — sources: `src/cli/main.ts` (default command),
> `src/format.ts::formatTextOutput`, `rust/src/audio.rs` (decode + resample),
> `rust/src/cli/transcribe.rs`. Audio decode errors use messages like
> `unsupported audio format: <path>` / `no supported audio tracks in: <path>`.*

### Requirement: Exit codes distinguish success, runtime failure, and bad usage

The CLI SHALL exit 0 when every input file transcribed successfully, 1 when any
file failed at runtime, and 2 for argument-validation errors — those the CLI
raises before any Engine work, whether for the whole invocation (a flag conflict,
no input) or for one file of a batch (a directory positional, a flag the
installed Engine's `describe` does not list).

#### Scenario: Exit-code contract in a script

- GIVEN a shell script that branches on `$?`
- WHEN it runs `kesha good.ogg` / `kesha missing.ogg` / `kesha --json --toon x.ogg`
- THEN it observes exit codes 0, 1, and 2 respectively

#### Scenario: A per-file argument rejection is still a usage error

- GIVEN the installed Engine does not support `--itn`
- WHEN Ira runs `kesha --itn call.ogg`
- THEN stderr carries `error [E_INVALID_ARG]:` naming `--itn`
- AND the process exits 2, not 1, without any progress output
