## Context

`rust/src/transcribe/diarize.rs` spawns a worker thread, calls
`FluidAudio::diarize_file_with_models`, and waits on an `mpsc` channel with
`recv_timeout`. The timeout is the only control the Engine has, and on expiry the worker
thread is deliberately abandoned — safe because diarization only runs in a one-shot CLI
invocation (#434).

Everything below rests on a spike (`/tmp/diarize-control-spike/`, deleted) that ran the
pinned `SortformerNvidiaLow_v2.mlpackage` through `SortformerDiarizer` directly at
FluidAudio 0.15.5, plus the FFI tests now in the fork.

## Decisions

### D1 — Supervise phases, don't scale a clock

The adaptive formula (`0.05 s` per audio-second, `0.10 s` per ASR segment, floor 150 s,
cap 1800 s) scaled the budget with audio length. The measurements say the dominant cost
is a *constant* — a 107 s model load that does not care how long the audio is — and that
the audio-proportional part is well behaved at a 0.19 real-time factor.

So the budgets bind phases instead:

| phase | budget | measured worst case | headroom |
|---|---|---|---|
| model load (no progress yet) | 300 s | 107.3 s cold | 2.8x |
| no chunk reported | 60 s | 1.2 s widest gap (cpu-only) | 50x |

Chunks land ~11/s on `.all` and ~2.8/s on `.cpuOnly`, so a 60 s silence is not a slow
machine — it is a wedged one.

No overall cap by default. A cap can only be wrong: too low kills healthy long runs (the
old 1800 s would have killed a 10-hour recording at the 30-minute mark), and too high is
indistinguishable from none. `KESHA_DIARIZE_TIMEOUT_SECS` stays for callers who want one,
now meaning what its name says.

The deadline is checked once per loop iteration rather than in the `recv_timeout` timeout
arm. A healthy run reports a chunk every ~0.1 s, so that arm never runs — the first
implementation put the check there and the cap silently never fired.

### D2 — Cancellation is a token, not a flag, and we wait for it

Only the chunk loop is cancellable: `processCompleteInternal` calls
`try Task.checkCancellation()` before each inference. The `MLModel` load ahead of it is a
single synchronous CoreML call with no interruption point, which is why the load phase
keeps the old abandon-the-thread behaviour and the processing phase does not.

The thread that decides to stop is not the thread parked inside the call, so a plain
`AtomicBool` on the Rust side would not help — the Swift `Task` handle is what has to be
cancelled. The binding therefore exposes a retained Swift token
(`fluidaudio_diarize_cancel_token_new` / `_cancel` / `_free`) whose `cancel()` is
thread-safe and sticky: a cancel arriving before the task is adopted still cancels it, so
a watchdog racing a fast start cannot lose the request.

Cancelling and returning immediately is not enough. Doing so reproducibly segfaulted the
process (exit 139) as it exited underneath the still-unwinding Swift task. `stop_worker`
therefore waits up to 10 s for the worker to acknowledge — measured unwind is 0.06 s — and
falls back to abandoning it only if the wait expires, which in practice means the
uninterruptible load.

### D3 — Compute units belong to the binding, not to FluidAudio

`SortformerDiarizer.initialize(models:)` takes no compute-unit argument because the
caller supplies an already-loaded `MLModel`. The binding was hardcoding
`cfg.computeUnits = .all`, so this is purely a matter of parameterising our own load.
The `MLModel` cache is now keyed by path *and* units — otherwise the second caller
silently gets the first one's units.

The selector crosses the FFI as a kebab-case string and an unrecognised value fails the
call, matching the Kokoro compute-unit contract established in the same binding. Failing
beats defaulting: a caller who asks for `cpu-only` because the ANE is broken must not
silently get the ANE.

### D4 — Progress is throttled by the supervisor, not the callback

The callback fires per chunk — 191 times for 92 s of audio. The worker forwards every one
over the channel (cheap) and the supervising thread decides what reaches stderr, at most
one line per 5 s. Keeping the decision on one thread means the stall detector and the
output share a single view of the run, and stderr is written from one place.

Progress counts whole chunks, so the final report lands around 99% rather than 100% (a
partial trailing chunk is never counted). Completion is the `Finished` event, never
`processed == total`.

## Risks

- **A long ANE compile on a slower machine than the M2 measured here.** 300 s is 2.8x the
  measured cold load; if that proves tight the failure is loud and names the phase, and
  `KESHA_DIARIZE_COMPUTE_UNITS=cpu-and-gpu` sidesteps the compile entirely.
- **stderr noise.** Diarization now writes 3–15 lines where it wrote none. `--speakers`
  already requires `--json`, and stdout stays clean, so the affected surface is
  interactive use and logs.
- **Fork pin.** The Engine now pins a fork branch rev rather than the previous rev; the
  binding change is additive (a new C symbol beside the old one, whose arity is
  untouched).
