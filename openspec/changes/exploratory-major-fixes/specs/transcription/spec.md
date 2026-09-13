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

### Requirement: Machine-readable output formats

The CLI SHALL provide JSON (`--json` / `--format json`) and TOON (`--toon` /
`--format toon`) output: an array of per-file result objects
(`file`, `text`, `lang`, and detection/timing fields), with TOON losslessly
round-tripping to the same data as JSON. The CLI SHALL also provide
`--format transcript` (text plus a `[lang: <code>, confidence: <n>]` trailer)
and `--verbose`, which prints detection details and STT time to stderr for
every output format; stdout carries the result alone, so a redirected
`--verbose` run leaves a file holding nothing but the transcript.

#### Scenario: Sona requests JSON

- WHEN Sona runs `kesha --json call.ogg`
- THEN stdout is a 2-space-indented JSON array with one result object containing
  at least `file`, `text`, and `lang`
- AND the process exits 0

#### Scenario: TOON for LLM piping

- WHEN Sona runs `kesha --toon call1.ogg call2.ogg`
- THEN stdout is a TOON document that `@toon-format/toon`'s `decode()` turns
  back into the same result array `--json` would have printed

#### Scenario: Structured error reporting opt-in

- GIVEN `b.ogg` is missing
- WHEN Ira runs `kesha --json --include-errors a.ogg b.ogg` (or the same with
  `--toon`)
- THEN stdout is `{ "results": [...], "errors": [...] }` where the error record
  for `b.ogg` carries a stable error code, TOON encoding the same envelope
- AND without `--include-errors` stdout would be the plain results array
  holding only `a.ogg`

#### Scenario: Maks redirects a verbose run to a file

- WHEN Maks runs `kesha --verbose note.ogg > note.txt`
- THEN `note.txt` holds the transcript and nothing else
- AND the `Audio language`, `Text language` and `STT time` lines appear on
  stderr

### Requirement: Long audio is handled via VAD or chunking, never silently truncated

The CLI SHALL transcribe audio of any length: with VAD installed, audio of
120 seconds or longer is automatically split on speech boundaries (auto mode);
`--vad` forces splitting (and fails if the VAD model is not installed);
`--no-vad` forces a single pass and SHALL fail rather than truncate when the
file exceeds the single-pass ceiling (24 minutes), reporting the refusal as the
Error code `E_INVALID_ARG` before any model is required. Without VAD installed,
long audio falls back to fixed overlapping windows with boundary deduplication.

#### Scenario: Hour-long recording with VAD installed

- GIVEN the Silero VAD model is installed
- WHEN Maks runs `kesha lecture.mp3` on a 60-minute file
- THEN the full lecture is transcribed via VAD-segmented passes
- AND the process exits 0

#### Scenario: Forcing VAD without the model

- GIVEN the VAD model is not installed
- WHEN Ira runs `kesha --vad call.ogg`
- THEN the run fails with an actionable `kesha install --vad` hint
- AND the process exits 1

#### Scenario: --no-vad on a file over the ceiling

- WHEN Ira runs `kesha --no-vad marathon.mp3` on a 30-minute file
- THEN the run fails early explaining the single-pass limit instead of
  returning a truncated transcript
- AND the Error code is `E_INVALID_ARG`, because the flag is the caller's
  choice and dropping it is the remedy, not a bug report
- AND the refusal does not depend on the ASR model being installed

> *Technical Note — VAD auto mode triggers at ≥120 s duration (and file size
> >200 KB); single-pass ceiling `FULL_FILE_SINGLE_PASS_MAX_SECONDS` = 24 min;
> fixed-window fallback uses 10-minute windows with 5-second overlap and
> ≥8-char boundary dedup. `validate_plain_transcribe_safety` runs before
> `ensure_asr_installed` and codes its refusal `ErrorCode::InvalidArg`. Sources:
> `rust/src/transcribe/mod.rs`, `rust/src/vad.rs`, `src/cli/main.ts` (VAD flag
> plumbing).*
