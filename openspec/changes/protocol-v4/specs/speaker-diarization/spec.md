## MODIFIED Requirements

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
