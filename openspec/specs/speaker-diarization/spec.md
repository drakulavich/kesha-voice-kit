# Speaker Diarization Specification

## Purpose

Speaker Diarization labels each Transcription Segment with a Speaker index so
Maks can read a meeting transcript and see who said what. It runs as a
post-processing step after ASR: the Engine diarizes the audio with the
Sortformer CoreML model and projects each span onto the ASR Segments by
midpoint overlap. The CLI activates it via `--speakers`.

Everything runs locally. No network access is required beyond the initial
`kesha install --diarize` that stages the model.

## Non-Goals

- Diarization does not identify *who* a speaker is — it assigns cluster indices
  (`0`, `1`, `2`, …) that have no meaning across separate calls.
- Diarization is darwin-arm64 only. Other platforms receive a clear error
  pointing at the tracking issue; there is no ONNX fallback.
- Speaker count is not configurable. The model determines it automatically.
- `--speakers` does not improve transcription text quality; it only adds
  `speaker` fields to the Segment objects.

## Requirements

### Requirement: Speaker labels require structured output and timestamps

The CLI SHALL reject `--speakers` when the output format is not JSON or TOON,
and SHALL exit 2 with an actionable message before spawning the Engine.
`--speakers` implies `--timestamps`: the CLI SHALL automatically enable segment
timestamps when `--speakers` is set.

#### Scenario: Ira runs --speakers without --json

- GIVEN the Engine is installed with diarization support
- WHEN Ira runs `kesha --speakers meeting.ogg`
- THEN the CLI prints an error explaining that `--speakers` requires
  `--json`, `--toon`, or `--format {json,toon}` to stderr
- AND the process exits 2 without spawning the Engine

#### Scenario: Maks requests diarized JSON

- GIVEN the Engine, ASR models, and the diarize model are installed on
  darwin-arm64
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN stdout is a JSON result array where each segment object carries a
  numeric `speaker` field (e.g. `0`, `1`, `2`)
- AND the process exits 0

> *Technical Note — exit 2 flag check: `src/cli/main.ts` lines 278–279.
> `--speakers` implies `with_segments = true` via `TranscribeOptionsBuilder`
> (`rust/src/transcribe/mod.rs`, `rust/src/transcribe/options.rs`).*

### Requirement: Diarization is gated on darwin-arm64 and the installed model

The Engine SHALL reject `--speakers` at runtime on non-darwin-arm64 targets
with an `E_UNSUPPORTED_PLATFORM` error. On darwin-arm64, the Engine SHALL
check that the diarize model exists before running ASR, and SHALL fail with an
actionable `kesha install --diarize` hint if the model is missing.

#### Scenario: Linux CI runs with --speakers

- GIVEN `kesha-engine` is the ONNX build (Linux)
- WHEN Ira runs `kesha --json --speakers call.ogg`
- THEN the Engine reports that speaker diarization is darwin-arm64 only
- AND the process exits 1

#### Scenario: Model not installed on darwin-arm64

- GIVEN the Engine has the `system_diarize` feature but
  `~/.cache/kesha/models/diarize/SortformerNvidiaLow_v2.mlpackage` is absent
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN the Engine reports the missing model and suggests `kesha install --diarize`
- AND the diarize preflight error fires before ASR model lookup
- AND the process exits 1

#### Scenario: KESHA_DIARIZE_MODEL_PATH points to a non-existent path

- GIVEN `KESHA_DIARIZE_MODEL_PATH=/tmp/missing.mlpackage` and that path does
  not exist
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN the error names the non-existent path from the env var
- AND the process exits 1 without running ASR

> *Technical Note — platform gate: `rust/src/transcribe/mod.rs` lines 213–219
> (`#[cfg(not(all(feature = "system_diarize", target_os = "macos")))]`).
> Model path resolution: `resolve_diarize_model_path` in
> `rust/src/transcribe/mod.rs` lines 746–768. `system_diarize` feature:
> `rust/Cargo.toml` line 39.*

### Requirement: Adaptive timeout protects against stalled CoreML calls

The Engine SHALL apply an adaptive timeout to the blocking diarization call.
The default floor is 150 s; the timeout scales up by audio duration and ASR
segment count, capped at 1800 s (30 minutes). `KESHA_DIARIZE_TIMEOUT_SECS`
overrides the adaptive value entirely. On timeout the Engine SHALL report
`E_DIARIZE_TIMEOUT` with an actionable message that names the elapsed time,
the audio duration, and suggests `kesha install --diarize` to warm the ANE
cache.

#### Scenario: Short recording completes well within the floor

- GIVEN a 5-minute meeting recording
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN diarization completes and the timeout never fires
- AND every Segment in the output carries a `speaker` value

#### Scenario: Diarization stalls on a cold ANE cache

- GIVEN the Apple ANE compile cache has been evicted and `KESHA_DIARIZE_TIMEOUT_SECS=5`
- WHEN Maks runs `kesha --json --speakers meeting.ogg` on a 10-minute recording
- THEN the Engine reports `E_DIARIZE_TIMEOUT` on stderr, names the 5 s limit and
  the audio duration, and suggests re-running `kesha install --diarize`
- AND the process exits 1

#### Scenario: KESHA_DIARIZE_TIMEOUT_SECS overrides the adaptive limit

- GIVEN `KESHA_DIARIZE_TIMEOUT_SECS=3600`
- WHEN the Engine computes the adaptive timeout for a 2-hour recording
- THEN the returned timeout is exactly 3600 s, ignoring the adaptive formula

> *Technical Note — constants: `DEFAULT_DIARIZE_TIMEOUT_SECS = 150`,
> `MAX_ADAPTIVE_DIARIZE_TIMEOUT_SECS = 1800`,
> `DIARIZE_TIMEOUT_SECONDS_PER_AUDIO_SECOND = 0.05`,
> `DIARIZE_TIMEOUT_SECONDS_PER_ASR_SEGMENT = 0.10`.
> Source: `rust/src/transcribe/diarize.rs` lines 30–33.
> Error code `E_DIARIZE_TIMEOUT`: `rust/src/errors.rs` line 86.*

### Requirement: Coverage validation prevents silently partial labels

After diarization, the Engine SHALL validate that at least 95 % of ASR
Segments have been labeled by midpoint overlap, AND that the diarization
timeline ends no more than 30 s before the final ASR Segment. If either
check fails, the Engine SHALL report an error with labeled/total counts and
the span/transcript end times.

#### Scenario: Full meeting is labeled

- GIVEN a 4-speaker meeting where diarization spans cover the full ASR timeline
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN all Segments carry a `speaker` value and the process exits 0

#### Scenario: Diarization stops mid-recording

- GIVEN diarization spans end at 10 s while the ASR transcript runs to 110 s
- THEN the Engine reports a coverage error naming `spans end at 10.0s while
  transcript ends at 110.0s`
- AND the process exits 1

> *Technical Note — constants: `MIN_DIARIZE_SEGMENT_COVERAGE = 0.95`,
> `MAX_DIARIZE_TAIL_GAP_SECONDS = 30.0`.
> Source: `rust/src/transcribe/diarize.rs` lines 20–21.
> Validation function: `validate_coverage` in
> `rust/src/transcribe/diarize.rs` lines 212–265.*

### Requirement: Speaker ids are cluster indices stable within one call only

The Engine SHALL assign Speaker ids as unsigned integers starting from 0,
ordered by first appearance. The same physical speaker in two separate
invocations MAY receive different ids. Distinct FluidAudio speaker labels
SHALL never collapse onto the same cluster index.

#### Scenario: Four-speaker meeting produces ids 0–3

- GIVEN a recording with four distinct speakers
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN the `speaker` values in the output are drawn from `{0, 1, 2, 3}`,
  each assigned in first-appearance order

#### Scenario: Re-running the same file may produce different ids

- WHEN Maks runs `kesha --json --speakers meeting.ogg` twice
- THEN the speaker index for a given physical voice MAY differ between the two
  runs; Maks MUST NOT rely on cross-run stability

> *Technical Note — id mapping: `speaker_id_to_index` in
> `rust/src/transcribe/diarize.rs` lines 194–201. The midpoint-overlap merge
> that projects spans onto ASR Segments: `merge_into` in
> `rust/src/transcribe/diarize.rs` lines 275–290.*

### Requirement: Output shape — speaker field on segments

JSON and TOON output SHALL include a `speaker` field of type `u32` on each
`segments[]` entry when `--speakers` is active. Segments whose midpoint falls
outside every diarization span SHALL omit the `speaker` field entirely.

#### Scenario: Sona parses diarized JSON

- WHEN Sona runs `kesha --json --speakers call.ogg`
- THEN each object in `results[0].segments` either has a numeric `speaker`
  field or omits it entirely — there is no `null` or `"unknown"` value
- AND Sona can group segments by `speaker` value to reconstruct per-speaker
  turns

#### Scenario: Unlabeled segment has no speaker field

- GIVEN a Segment whose midpoint falls in a gap between diarization spans
- THEN that Segment is serialized without a `speaker` key in the JSON output

> *Technical Note — Rust struct definition: `TranscriptionSegment.speaker:
> Option<u32>` with `#[serde(skip_serializing_if = "Option::is_none")]` in
> `rust/src/transcribe/mod.rs` lines 96–101.*

## Open Issues

- Diarization is darwin-arm64 only; the tracking issue for ONNX-based
  diarization on Linux/Windows is
  https://github.com/drakulavich/kesha-voice-kit/issues/199.
- The first `--speakers` call after OS boot may take longer than the adaptive
  floor because the Apple ANE compiles the CoreML model from scratch. Re-running
  `kesha install --diarize` warms the compile cache and makes subsequent calls
  fast (see #443).
