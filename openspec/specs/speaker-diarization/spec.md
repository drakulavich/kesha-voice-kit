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

### Requirement: Diarization engages VAD windowing at any duration

When `--speakers` is requested the Engine SHALL force VAD preprocessing
regardless of audio duration, overriding the 120 s auto-VAD threshold, and SHALL
fail with an actionable message naming `kesha install --vad` when the VAD model
is missing. An explicit `--no-vad` SHALL be refused rather than silently
overridden: the CLI SHALL exit 2 before spawning the Engine, and the Engine, if
reached directly, SHALL report `E_INVALID_ARG` before resolving any model.

#### Scenario: Maks diarizes a 6-second voice-note exchange

- GIVEN a two-speaker 6.6 s recording and the VAD + diarize models installed
- WHEN Maks runs `kesha --json --speakers exchange.wav` without `--vad`
- THEN the Engine segments the audio with VAD before diarizing
- AND the Segments carry distinct `speaker` values and the process exits 0

#### Scenario: Ira combines --speakers with --no-vad

- WHEN Ira runs `kesha --json --speakers --no-vad meeting.ogg`
- THEN the CLI prints an error explaining that speaker labels attach to
  VAD-windowed Segments and that `--no-vad` leaves nothing to label
- AND the process exits 2 without spawning the Engine

> *Technical Note — VAD is forced because speaker labels attach to ASR Segments:
> without VAD the transcript is a single whole-file Segment with nothing to label.
> The two layers report `--no-vad` differently on purpose: CLI flag gates exit 2
> with an uncoded message (the `validateTranscribeArgs` convention), while the
> Engine exits 1 with `E_INVALID_ARG`. The Engine checks the flag pair before
> resolving any model so an invalid invocation reads as invalid even with nothing
> installed. `reject_no_vad_with_speakers` runs at the top of
> `transcribe_with_options` and `vad_mode_for_diarization` resolves the mode
> before the ASR install check (`rust/src/transcribe/mod.rs`); the CLI-side
> exit-2 guard lives in `validateTranscribeArgs` (`src/cli/main.ts`) and the
> model preflight in `src/engine.ts`. Closes #768.*

### Requirement: Installing diarization installs the VAD model too

`kesha install --diarize` SHALL also install the VAD model, and the CLI preflight
for `--speakers` SHALL check for both the diarize and the VAD model before
spawning the Engine.

#### Scenario: Maks installs diarization once

- GIVEN neither the diarize nor the VAD model is installed on darwin-arm64
- WHEN Maks runs `kesha install --diarize`
- THEN both the diarize model and the VAD model are present in the Model cache
- AND `kesha --json --speakers meeting.ogg` runs without asking for `--vad`

#### Scenario: The VAD model is missing at transcription time

- GIVEN the diarize model is installed but the VAD model is not
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN the CLI reports `E_MODEL_MISSING` saying speaker diarization requires the
  VAD model, with a hint naming `--vad`
- AND the process exits 1 without spawning the Engine

> *Technical Note — speaker labels depend on VAD, so `--diarize` pulls `--vad` into
> the install argv (`src/engine-install.ts`, #768). The preflight is
> `assertSpeakerModelsInstalled` in `src/engine.ts`, which runs
> `assertDiarizeModelInstalled` then `assertVadModelInstalled`.*

### Requirement: Diarization is gated on darwin-arm64 and the installed model

The Engine SHALL reject `--speakers` at runtime on non-darwin-arm64 targets
with an `E_UNSUPPORTED_PLATFORM` error. On darwin-arm64, the Engine SHALL
check that the diarize model exists before running ASR, and SHALL fail with an
actionable setup hint naming `--diarize` (`kesha init --diarize` on an
interactive TTY, `kesha install --diarize` when stderr is piped) if the model is
missing.

#### Scenario: Linux CI runs with --speakers

- GIVEN `kesha-engine` is the ONNX build (Linux)
- WHEN Ira runs `kesha --json --speakers call.ogg`
- THEN the Engine reports that speaker diarization is darwin-arm64 only
- AND the process exits 1

#### Scenario: Model not installed on darwin-arm64

- GIVEN the Engine has the `system_diarize` feature but
  `~/.cache/kesha/models/diarize/SortformerNvidiaLow_v2.mlpackage` is absent
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN the missing model is reported with an actionable setup hint naming
  `--diarize` — `kesha init --diarize` on a TTY, `kesha install --diarize` when
  stderr is piped (`installHint("--diarize")`,
  `src/engine.ts::assertDiarizeModelInstalled`)
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

### Requirement: Coverage validation prevents silently partial labels

After diarization, the Engine SHALL validate that at least 95 % of ASR
Segments are labeled by midpoint overlap, AND that the diarization timeline
ends no more than 30 s before the final ASR Segment. A failed check SHALL report
an error with labeled/total counts and the span/transcript end times. The
percentage check SHALL be skipped when there
is exactly one ASR Segment. No spans at all SHALL fail closed at any Segment
count, except for a clip below the diarizer floor (next requirement).

#### Scenario: Ira diarizes a voice command shorter than the model's window

- GIVEN a 0.9 s recording and the VAD + diarize models installed
- WHEN Ira runs `kesha --json --speakers short.wav`
- THEN stderr says no speaker spans came back, that the clip is 0.90 s against a
  1.04 s floor, and that the transcript is returned without speaker labels
- AND stdout carries the transcript, whose Segments omit `speaker` entirely
- AND the process exits 0

#### Scenario: A container that under-reports its own length does not open the exception

- GIVEN a file whose header claims 0.3 s, diarization returning no spans, and an ASR
  transcript running to 60 s
- THEN the Engine reports the coverage error naming `labeled 0/1 segments` rather
  than degrading, and the process exits 1

#### Scenario: A single whole-file Segment does not fail closed

- GIVEN one ASR Segment spanning 0–6.6 s and diarization spans 0–3.0 s and
  3.5–6.2 s, so the Segment midpoint at 3.3 s falls between them
- THEN the Engine reports no coverage error, and the Segment is returned without
  a `speaker` field rather than the request failing

#### Scenario: Full meeting is labeled

- GIVEN a 4-speaker meeting where diarization spans cover the full ASR timeline
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN all Segments carry a `speaker` value and the process exits 0

#### Scenario: Diarization stops mid-recording

- GIVEN diarization spans end at 10 s while the ASR transcript runs to 110 s
- THEN the Engine reports a coverage error naming `spans end at 10.0s while
  transcript ends at 110.0s`
- AND the process exits 1

> *Technical Note — with exactly one ASR Segment the ratio can only be 0 % or
> 100 %, depending on whether that Segment's midpoint lands in a speaker-change
> gap, which measures absent segmentation rather than partial labeling.
> Constants: `MIN_DIARIZE_SEGMENT_COVERAGE = 0.95`,
> `MAX_DIARIZE_TAIL_GAP_SECONDS = 30.0`, `MIN_DIARIZABLE_SECONDS = 1.04`.
> Source: `rust/src/transcribe/diarize.rs`.
> Validation function: `validate_coverage`; the short-clip exception is
> `below_diarizer_floor`, which runs before it. The floor derives from
> `SortformerConfig.balancedV2`: `(chunkLen 6 + chunkRightContext 7) *
> subsamplingFactor 8 * melStride 160 / sampleRate 16 000`. Measured on a cut of
> `01-ne-nuzhno-slat-soobshcheniya.ogg`, the step is at ~1.023 s — 16 360 samples
> return 0 spans, 16 380 return 1 — so the derived value sits just above the
> observed one, and a clip in that 17 ms band degrades where it could still have
> been labeled. The duration cross-check is `max_asr_end`, the same clock
> `validate_coverage` uses. Closes #999.*

### Requirement: A clip below the diarizer floor returns an unlabeled transcript

The Engine SHALL return the transcript without `speaker` fields and exit 0 when
diarization returns no spans and the clip is shorter than the 1.04 s floor, and say
on stderr that the clip is below the floor and the requested labels are not in
the output. It SHALL believe a below-floor duration only when the ASR timeline
ends before 1.04 s; otherwise it SHALL fail closed.

#### Scenario: Maks diarizes a one-word reply

- GIVEN a 0.5 s recording whose ASR timeline ends at 0.4 s, and the VAD +
  diarize models installed
- WHEN Maks runs `kesha --json --speakers yes.wav`
- THEN stdout carries the transcript, whose Segments carry no `speaker` field
- AND stderr names the 1.04 s floor, and the process exits 0

#### Scenario: A clip just long enough to diarize loses all its labels

- GIVEN a 1.2 s recording whose ASR timeline ends at 1.1 s and diarization
  returning no spans
- WHEN Maks runs `kesha --json --speakers short.wav`
- THEN the Engine reports the coverage error rather than degrading
- AND the process exits 1

> *Technical Note — 1.04 s is what the Sortformer chunker needs before it can emit
> its first chunk, so an empty result below it is the clip being too short rather
> than labels going missing. A container can under-report its own duration, so the
> transcript has to agree before the measurement is believed, and the stderr
> notice never claims a length the transcript contradicts. A clip long enough to
> diarize is judged by the coverage checks unchanged, whether it lost some of its
> labels or all of them. `below_diarizer_floor` in
> `rust/src/transcribe/diarize.rs` (#999).*

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

### Requirement: Diarization reports progress and is supervised per phase

The Engine SHALL report diarization progress on stderr, never stdout, naming
the compute units at the start, the model load time once the binding reports the
model ready, and the percentage of audio processed at intervals. The
CLI SHALL relay each line as the Engine writes it, not once the run is over, and
SHALL NOT repeat relayed progress in the failure report, which keeps naming the
file and the Engine's own error. The run is supervised per phase as the next two
requirements state.

#### Scenario: Maks watches a long meeting diarize

- GIVEN a 3-minute recording and a warm model
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN stderr carries `diarize: loading the CoreML model on all`, then
  `diarize: model ready in 4.0s; reading the audio`, then percentage lines, then
  `diarize: done in 39.5s (20 spans)`
- AND stdout carries only the JSON result

#### Scenario: Maks watches the model load rather than a still bar

- GIVEN a cold ANE cache, so the model load runs for ~105 s
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN `diarize: loading the CoreML model on all` reaches his terminal before the
  load begins, and the cold-cache explanation while it is still going
- AND neither waits for the run to finish to be printed

#### Scenario: The first run after an ANE cache eviction

- GIVEN the Apple ANE compile cache is cold
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN stderr explains that the model is still loading and that a cold Neural
  Engine cache makes this take ~105 s, once
- AND the run completes rather than failing, because the load budget is 300 s
- AND the reported `model ready in …` time tells Maks the load — not the
  diarization — was the slow part

#### Scenario: The model loads but the audio never arrives

- GIVEN the model-ready marker has been reported
- WHEN no first chunk follows within the prepare budget
- THEN the Engine reports `E_DIARIZE_TIMEOUT` saying the model loaded and the
  read never produced a chunk, and does **not** suggest rewarming the ANE cache
  or switching compute units — neither can affect a phase the model has already
  cleared

#### Scenario: A slower host raises the load budget

- GIVEN `KESHA_DIARIZE_LOAD_TIMEOUT_SECS=900` on a machine whose cold ANE compile
  exceeds 300 s
- WHEN Ira runs `kesha --json --speakers meeting.ogg`
- THEN the load is allowed 900 s, and the error text that would have fired names
  that variable rather than the total cap, which cannot widen anything

#### Scenario: Diarization stops making progress

- GIVEN diarization has processed some chunks and then stops reporting any
- WHEN 60 s pass with no further chunk
- THEN the Engine cancels the run, reports `E_DIARIZE_TIMEOUT` naming the
  percentage reached and the chunk count, and does not suggest rewarming the ANE
  cache — the model has demonstrably already loaded
- AND the process exits 1

#### Scenario: Ira caps a run with KESHA_DIARIZE_TIMEOUT_SECS

- GIVEN `KESHA_DIARIZE_TIMEOUT_SECS=12`
- WHEN Ira runs `kesha --json --speakers --vad long-meeting.wav`
- THEN the Engine cancels at the cap, reports `E_DIARIZE_TIMEOUT` naming the
  variable and the percentage reached, and exits 1
- AND the message blames the cap rather than reporting a stall

> *Technical Note — progress that arrives only after the wait it described cannot
> tell a slow run from a hung one, which is what a silent 51 s model load was
> taken for (#1002). Constants: `MODEL_LOAD_BUDGET_SECS = 300`,
> `PREPARE_BUDGET_FLOOR_SECS = 60`, `PREPARE_BUDGET_PER_AUDIO_SECOND = 0.01`,
> `PROGRESS_STALL_BUDGET_SECS = 60`, `PROGRESS_REPORT_INTERVAL = 5 s`,
> `CANCEL_GRACE = 10 s` (the processing-phase floor; an uninterruptible phase
> instead waits out the rest of its own budget). Source:
> `rust/src/transcribe/diarize.rs`.
> Error code `E_DIARIZE_TIMEOUT`: `rust/src/errors.rs` line 86.
> Budgets are measured, not guessed: on an M2 a cold model load is 107.3 s and a
> warm one 0.8–4.4 s, reading and resampling 185 s of audio costs 0.26 s, and
> chunks land ~11/s on the Neural Engine (~2.8/s CPU-only) with a widest observed
> gap of 1.2 s. The phase boundaries come from the binding — a one-shot
> `DiarizeEvent::ModelReady` then per-chunk `DiarizeEvent::Progress`
> (`fluidaudio-rs`, `swift/Diarize_ffi.swift`) — so no phase is inferred from
> silence.*

### Requirement: Each diarization phase has its own time budget

The Engine SHALL supervise diarization with a budget per phase rather than one
wall-clock timeout, each phase delimited by a signal from the binding: 300 s for
the model load (up to the model-ready marker), 60 s plus 0.01 s per audio-second
for reading and resampling (up to the first processed chunk), and 60 s without a
processed chunk thereafter. Exceeding one SHALL cancel the run and report
`E_DIARIZE_TIMEOUT` naming the phase and offering only remedies that act on it.

#### Scenario: A ten-hour recording gets a longer read budget

- GIVEN a 10-hour recording and a warm model
- WHEN Ira runs `kesha --json --speakers archive.wav`
- THEN reading and resampling is allowed 420 s before the first chunk is due
- AND the run completes without `E_DIARIZE_TIMEOUT` while chunks keep arriving

#### Scenario: The model load outruns its budget

- GIVEN a model load that has not reported the model-ready marker after 300 s
- WHEN the load budget runs out
- THEN the Engine cancels the run and reports `E_DIARIZE_TIMEOUT` saying it gave
  up waiting for the CoreML model to load, before reading any audio
- AND the message offers rewarming with `kesha install --diarize`,
  `KESHA_DIARIZE_COMPUTE_UNITS=cpu-and-gpu`, and raising
  `KESHA_DIARIZE_LOAD_TIMEOUT_SECS`, and the process exits 1

> *Technical Note — `prepare_budget` and `stall_error` in
> `rust/src/transcribe/diarize.rs`; the 10-hour figure is pinned by
> `prepare_budget(36_000.0) == 420 s` there.*

### Requirement: Diarization time limits are set by environment variables

The Engine SHALL let `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` replace the 300 s
model-load budget. There SHALL be no default cap on total run time;
`KESHA_DIARIZE_TIMEOUT_SECS` optionally imposes one, and it SHALL only shorten a
run, never widen a phase budget.

#### Scenario: Ira's slow build host gets a longer load

- GIVEN `KESHA_DIARIZE_LOAD_TIMEOUT_SECS=600` and a cold model load of 400 s
- WHEN Ira runs `kesha --json --speakers meeting.ogg`
- THEN the load completes inside its budget and the run exits 0

#### Scenario: A generous total cap does not widen the stall budget

- GIVEN `KESHA_DIARIZE_TIMEOUT_SECS=3600` and a run that stops producing chunks
- WHEN 60 s pass with no further chunk
- THEN the Engine reports `E_DIARIZE_TIMEOUT` for the stall without waiting for
  the cap, and the process exits 1

> *Technical Note — the load budget is the one a user can tune, since a cold ANE
> compile is a fixed cost of the host rather than of the user's audio.
> `load_budget_from_env` and `positive_secs_from_env` in
> `rust/src/transcribe/diarize.rs`.*

### Requirement: Cancellation stops the CoreML work

When the Engine abandons a diarization it SHALL cancel the underlying Swift task
and wait for it to unwind before returning. The wait SHALL be as long as the
cancelled phase needs: 10 s while processing chunks, and the remainder of the
current phase's own budget while loading the model or reading the audio. Only
once a phase outlives its full budget does the Engine fall back to abandoning
the worker thread for process exit to reap.

#### Scenario: A capped run exits cleanly

- GIVEN `KESHA_DIARIZE_TIMEOUT_SECS=12` and a run that will exceed it
- WHEN the cap is reached mid-processing
- THEN the Engine cancels, the Swift task stops within one chunk, and the
  process exits 1 — not with a signal

#### Scenario: A cap reached during a cold model load still exits cleanly

- GIVEN `KESHA_DIARIZE_TIMEOUT_SECS=1` and a cold Neural Engine cache whose
  model load takes ~105 s
- WHEN the cap is reached while the model is still loading
- THEN the Engine says on stderr that the load cannot be interrupted and how
  long it will wait
- AND it waits out the remainder of the load budget rather than 10 s, so the
  process exits 1 — not with a signal

> *Technical Note — returning while the Swift task is still running crashes the
> process during exit. The chunk loop is cancellable because the Swift side checks
> the token between chunks; the model load and the audio read are single calls, so
> a cancellation there only takes effect when the call returns, and a shorter wait
> would return under a live CoreML call. `stop_worker` in
> `rust/src/transcribe/diarize.rs`. The
> binding's `DiarizeCancelToken` is sticky and thread-safe, so the supervising
> thread can cancel work the worker thread is parked inside
> (`fluidaudio-rs`, `swift/Diarize_ffi.swift`).*

### Requirement: Compute units are selectable

The Engine SHALL load the Sortformer model on CoreML compute units chosen by
`KESHA_DIARIZE_COMPUTE_UNITS`, defaulting to `all`. Accepted values are `all`,
`cpu-and-ane`, `cpu-and-gpu` and `cpu-only`. An unrecognised value SHALL fail
with `E_INVALID_ARG` listing the accepted spellings rather than silently
diarizing on units the user did not ask for.

#### Scenario: Ira skips the Neural Engine

- GIVEN `KESHA_DIARIZE_COMPUTE_UNITS=cpu-and-gpu`
- WHEN Ira runs `kesha --json --speakers --vad meeting.wav`
- THEN diarization loads without paying the ANE compile and produces the same
  speaker labels, at roughly twice the processing time

#### Scenario: A typo fails loudly

- GIVEN `KESHA_DIARIZE_COMPUTE_UNITS=tpu`
- THEN the Engine exits with `E_INVALID_ARG` naming the four accepted values

> *Technical Note — `compute_units_from_env` in
> `rust/src/transcribe/diarize.rs`. There is deliberately no CLI flag: the
> Engine's `transcribe` subcommand takes a narrow flag set, and adding one would
> need a `gate_rows()` entry plus the describe-document validation the CLI
> applies to every other forwarded flag.*

## Open Issues

- Diarization is darwin-arm64 only; the tracking issue for ONNX-based
  diarization on Linux/Windows is
  https://github.com/drakulavich/kesha-voice-kit/issues/199.
- The first `--speakers` call after OS boot may take longer than the adaptive
  floor because the Apple ANE compiles the CoreML model from scratch. Re-running
  `kesha install --diarize` warms the compile cache and makes subsequent calls
  fast (see #443).
