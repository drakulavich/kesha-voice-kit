# Transcription Specification

## Purpose

Transcription is Kesha's default command: `kesha meeting.ogg` prints the spoken
words as text. It is the path Ira scripts in CI (pipe-friendly stdout, strict
exit codes, JSON/TOON for machines) and the one Maks uses ad hoc on voice notes.
Everything runs locally: the CLI spawns the Engine, which decodes the audio,
runs the Backend (Parakeet TDT 0.6B v3), and returns text — no network access.

## Non-Goals

- Transcription never downloads the Engine or models (Never-auto-download rule);
  a missing component fails with a `kesha install` hint.
- No live/streaming transcription — input is a finished audio file (see
  `audio-recording` for capturing one).
- No translation; the transcript is in the spoken language.
- Speaker labels are specified separately in `speaker-diarization`.

## Requirements

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

- WHEN Ira runs `kesha` with no arguments
- THEN a usage summary is printed to stderr
- AND the process exits 1

> *Technical Note — sources: `src/cli/main.ts` (default command),
> `src/format.ts:3` (text format), `rust/src/audio.rs` (decode + resample),
> `rust/src/cli/transcribe.rs`. Audio decode errors use messages like
> `unsupported audio format: <path>` / `no supported audio tracks in: <path>`.*

### Requirement: Batch transcription continues past per-file failures

The CLI SHALL accept multiple audio files in one invocation, transcribe them
sequentially, label each transcript with a `=== <file> ===` header in text mode,
and continue after a failing file rather than aborting the batch.

#### Scenario: One of three files is missing

- GIVEN `a.ogg` and `c.ogg` exist but `b.ogg` does not
- WHEN Ira runs `kesha a.ogg b.ogg c.ogg`
- THEN transcripts for `a.ogg` and `c.ogg` are printed, each under its
  `=== <file> ===` header
- AND the `b.ogg` error goes to stderr
- AND the process exits 1 (any failure fails the batch)

#### Scenario: All files succeed

- WHEN Maks runs `kesha note1.ogg note2.ogg`
- THEN both transcripts appear in input order with headers
- AND the process exits 0

### Requirement: Machine-readable output formats

The CLI SHALL provide JSON (`--json` / `--format json`) and TOON (`--toon` /
`--format toon`) output: an array of per-file result objects
(`file`, `text`, `lang`, and detection/timing fields), with TOON losslessly
round-tripping to the same data as JSON. The CLI SHALL also provide
`--format transcript` (text plus a `[lang: <code>, confidence: <n>]` trailer)
and `--verbose` (adds detection details and STT time to stderr-adjacent text
output).

#### Scenario: Sona requests JSON

- WHEN Sona runs `kesha --json call.ogg`
- THEN stdout is a 2-space-indented JSON array with one result object containing
  at least `file`, `text`, and `lang`
- AND the process exits 0

#### Scenario: TOON for LLM piping

- WHEN Sona runs `kesha --toon call1.ogg call2.ogg`
- THEN stdout is a TOON document that `@toon-format/toon`'s `decode()` turns
  back into the same result array `--json` would have printed

#### Scenario: JSON error reporting opt-in

- GIVEN `b.ogg` is missing
- WHEN Ira runs `kesha --json --include-errors a.ogg b.ogg`
- THEN stdout is `{ "results": [...], "errors": [...] }` where the error record
  for `b.ogg` carries a stable error code
- AND without `--include-errors` stdout would be the plain results array

### Requirement: Conflicting or incomplete flag combinations are rejected

The CLI SHALL validate flag combinations before starting the Engine and exit 2
with a stderr message when the request is contradictory.

The rejected combinations are: `--json` with `--toon`; `--format transcript`
combined with `--json` or `--toon`; `--timestamps` or `--speakers` without
`--json`/`--toon`; `--include-errors` without `--json`; `--vad` with
`--no-vad`; an unknown `--format` value.

#### Scenario: Both JSON and TOON requested

- WHEN Ira runs `kesha --json --toon call.ogg`
- THEN an error explaining the flags are mutually exclusive is printed to stderr
- AND the process exits 2 without spawning the Engine

#### Scenario: Timestamps in plain-text mode

- WHEN Maks runs `kesha --timestamps call.ogg`
- THEN the CLI exits 2 telling him `--timestamps` requires `--json` or `--toon`

### Requirement: Segment timestamps on demand

The CLI SHALL include per-Segment `start`/`end` times (seconds) in JSON/TOON
results when `--timestamps` is passed.

#### Scenario: Sona requests timestamps

- WHEN Sona runs `kesha --json --timestamps call.ogg`
- THEN each result's `segments` array contains objects with numeric `start`,
  `end`, and `text`

### Requirement: Expected-language mismatch warning

The CLI SHALL accept `--lang <code>` as the expected language and warn on
stderr — without failing — when confident detection disagrees with it.

#### Scenario: Russian audio declared as English

- GIVEN `ru.ogg` contains Russian speech detected with confidence above 0.8
- WHEN Ira runs `kesha --lang en ru.ogg`
- THEN the transcript is still printed and the process exits 0
- AND stderr carries a language-mismatch warning

### Requirement: Long audio is handled via VAD or chunking, never silently truncated

The CLI SHALL transcribe audio of any length: with VAD installed, audio of
120 seconds or longer is automatically split on speech boundaries (auto mode);
`--vad` forces splitting (and fails if the VAD model is not installed);
`--no-vad` forces a single pass and SHALL fail rather than truncate when the
file exceeds the single-pass ceiling (24 minutes). Without VAD installed, long
audio falls back to fixed overlapping windows with boundary deduplication.

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

> *Technical Note — VAD auto mode triggers at ≥120 s duration (and file size
> >200 KB); single-pass ceiling `FULL_FILE_SINGLE_PASS_MAX_SECONDS` = 24 min;
> fixed-window fallback uses 10-minute windows with 5-second overlap and
> ≥8-char boundary dedup. Sources: `rust/src/transcribe/mod.rs`,
> `rust/src/vad.rs`, `src/cli/main.ts` (VAD flag plumbing).*

### Requirement: Exit codes distinguish success, runtime failure, and bad usage

The CLI SHALL exit 0 when every input file transcribed successfully, 1 when any
file failed at runtime, and 2 for argument-validation errors.

#### Scenario: Exit-code contract in a script

- GIVEN a shell script that branches on `$?`
- WHEN it runs `kesha good.ogg` / `kesha missing.ogg` / `kesha --json --toon x.ogg`
- THEN it observes exit codes 0, 1, and 2 respectively

## Open Issues

- VAD auto mode silently skips when the audio file is under 200 KB even if it
  is long in duration (low-bitrate edge case) — intentional today, revisit if
  low-bitrate long files surface in support.
- Audio language detection is skipped for transcripts over 10 minutes; the
  `--lang` mismatch warning therefore cannot fire on very long files.
