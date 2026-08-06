## Why

`kesha --speakers` runs diarization by making one blocking call into FluidAudio and
waiting. Nothing comes back until it is over, so the Engine races a wall clock it
cannot inform: a 150 s floor, scaled by audio length and ASR segment count, capped at
1800 s. Every number in that formula is a guess standing in for information the Engine
did not have.

Two things follow from that. The user sees nothing for minutes and cannot tell a
working run from a wedged one. And when the clock does expire, the Engine reports
"timed out" without knowing what was slow, so #443's "slow once after a reboot" could
only ever be *inferred* — the error text guesses at a cold ANE cache because that is the
usual suspect, not because anything measured it.

Measured on an M2 (macOS 26.5.2) against the pinned `SortformerNvidiaLow_v2` package
and 92.4 s of two-speaker audio, the guess turns out to be mostly right and entirely
unactionable:

| phase | cold | warm |
|---|---|---|
| `MLModel.compileModel` (`.mlpackage` → `.mlmodelc`) | 0.27 s | cached |
| `MLModel(contentsOf:, .all)` | **107.33 s** | 0.75–4.4 s |
| processing 92.4 s of audio | 17.5 s | 17.5 s |

So #443 is a *model load*, not a slow diarization — and 87% of the cold wall time
happens before a single sample is processed. The adaptive formula scaled the wrong
number: it grew the budget with audio length, while the part that actually blows up is
constant and independent of the audio.

The 1800 s cap was also actively wrong in the other direction. At the measured 0.19
real-time factor a 10-hour recording legitimately needs about two hours, and the cap
would have killed it at thirty minutes.

FluidAudio 0.15.5 — already in the pin — carries everything needed to replace guessing
with measurement, on the exact call path this Engine uses. `SortformerDiarizer.processComplete`
takes a `progressCallback`, polls `Task.checkCancellation()` between chunks, and the
compute units are the binding's own choice. None of it is specific to the v3 models
that are out of scope here.

## What Changes

- Diarization reports progress on stderr: the compute units it is loading on, how long
  the load took once the model is ready, and the percentage of audio processed. A cold
  load says so while it is happening instead of going silent for two minutes.
- The single wall-clock timeout is replaced by two budgets against the phase each one
  can actually bound — 300 s for the model load, 60 s without a processed chunk once
  processing has started. Both are ~3x and ~50x the measured worst case respectively.
- There is no default cap on total run time any more. `KESHA_DIARIZE_TIMEOUT_SECS`
  still exists as an opt-in cap.
- Abandoning a run now cancels the CoreML work and waits for it to unwind. Returning
  while the Swift task is still running segfaults the process during exit; that was
  reproducible before this change and is fixed by it.
- `KESHA_DIARIZE_COMPUTE_UNITS` selects the compute units, defaulting to today's
  behaviour. `cpu-and-gpu` skips the ANE compile entirely at roughly twice the
  processing time — the escape hatch for hosts where the ANE is unusable.
- The binding (`drakulavich/fluidaudio-rs`) grows a controlled diarize entry point
  beside the existing one, carrying progress, cancellation and compute units.

Out of scope, deliberately: the v3 Sortformer models. Those are a separate pin decision
with their own verification; everything here works against the v2 package already
pinned in `rust/src/models.rs`.

## Capabilities

### New Capabilities

None. `transcribe.diarize` already advertises the feature; this changes how it behaves,
not whether it exists.

### Modified Capabilities

- **speaker-diarization** — progress reporting, per-phase supervision, cancellation,
  and compute-unit selection replace the adaptive timeout.
- **engine-contract** — `KESHA_DIARIZE_TIMEOUT_SECS` changes meaning from "override the
  adaptive timeout" to "optional overall cap"; `KESHA_DIARIZE_COMPUTE_UNITS` is new.

## Non-Goals

- No CLI flag for compute units. The Engine's `transcribe` subcommand takes a narrow
  flag set, and adding one would mean extending `--capabilities-json` negotiation for a
  knob whose only users are troubleshooting a broken host. The env var is enough.
- No SIGINT handler. The Engine installs none today, and the default disposition
  terminates the process, so there is nothing to orphan; giving diarization a signal
  handler is its own change.
- Making the cold load faster. It is Apple's CoreML program compile. This change makes
  it legible, not shorter.
