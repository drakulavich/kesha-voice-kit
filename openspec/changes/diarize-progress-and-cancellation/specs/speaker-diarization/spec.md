## REMOVED Requirements

### Requirement: Adaptive timeout protects against stalled CoreML calls

**Reason**: The adaptive formula existed only because the blocking diarization
call reported nothing, so a wall clock was the only signal available. With
per-chunk progress the Engine can tell a stalled run from a slow one, and the
1800 s cap was actively wrong — a 10-hour recording legitimately needs ~2 h at
the measured 0.19 real-time factor.

**Migration**: `KESHA_DIARIZE_TIMEOUT_SECS` keeps working, now as an optional
overall cap rather than an override of a default that no longer exists.

## ADDED Requirements

### Requirement: Diarization reports progress and is supervised per phase

The Engine SHALL report diarization progress on stderr — never stdout — naming
the compute units at the start, the model load time once the model is ready, and
the percentage of audio processed at intervals thereafter.

The Engine SHALL supervise the run with two budgets rather than one wall-clock
timeout: 300 s for the model load (no progress reported yet) and 60 s without a
processed chunk once processing has begun. Exceeding either SHALL cancel the run
and report `E_DIARIZE_TIMEOUT` with a message naming which phase stalled. There
SHALL be no default cap on total run time; `KESHA_DIARIZE_TIMEOUT_SECS`
optionally imposes one.

#### Scenario: Maks watches a long meeting diarize

- GIVEN a 3-minute recording and a warm model
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN stderr carries `diarize: loading the CoreML model on all`, then
  `diarize: model ready in 4.4s; processing audio`, then percentage lines, then
  `diarize: done in 39.3s (44 spans)`
- AND stdout carries only the JSON result

#### Scenario: The first run after an ANE cache eviction

- GIVEN the Apple ANE compile cache is cold
- WHEN Maks runs `kesha --json --speakers meeting.ogg`
- THEN stderr explains that the model is still loading and that a cold Neural
  Engine cache makes this take ~105 s, once
- AND the run completes rather than failing, because the load budget is 300 s
- AND the reported `model ready in …` time tells Maks the load — not the
  diarization — was the slow part

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

> *Technical Note — constants: `MODEL_LOAD_BUDGET_SECS = 300`,
> `PROGRESS_STALL_BUDGET_SECS = 60`, `PROGRESS_REPORT_INTERVAL = 5 s`,
> `CANCEL_GRACE = 10 s`. Source: `rust/src/transcribe/diarize.rs`.
> Error code `E_DIARIZE_TIMEOUT`: `rust/src/errors.rs` line 86.
> Budgets are measured, not guessed: on an M2 a cold model load is 107.3 s and a
> warm one 0.8–4.4 s, and chunks land ~11/s on the Neural Engine (~2.8/s
> CPU-only) with a widest observed gap of 1.2 s.*

### Requirement: Cancellation stops the CoreML work

When the Engine abandons a diarization it SHALL cancel the underlying Swift task
and wait up to 10 s for it to unwind before returning. Returning while the task
is still running crashes the process during exit.

The chunk loop is cancellable; the model load is not. A cancellation requested
during the load SHALL take effect once the load completes, and if the load
itself exceeds its budget the Engine falls back to abandoning the worker thread
for process exit to reap.

#### Scenario: A capped run exits cleanly

- GIVEN `KESHA_DIARIZE_TIMEOUT_SECS=12` and a run that will exceed it
- WHEN the cap is reached mid-processing
- THEN the Engine cancels, the Swift task stops within one chunk, and the
  process exits 1 — not with a signal

> *Technical Note — `stop_worker` in `rust/src/transcribe/diarize.rs`. The
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
> Engine's `transcribe` subcommand takes a narrow flag set and adding one would
> require the `--capabilities-json` negotiation the CLI uses for every other
> forwarded flag.*
