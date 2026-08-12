# Design — live transcription on `kesha record`

## The spike, and what it changed about this design

Ticket #711 claimed the streaming ASR API was "already exposed by the current
pin, no upstream work". Its sibling #710 made the same claim and it was false —
the bound symbol was an inert shim. So the premise was tested first, in a
throwaway harness against the pinned `fluidaudio-rs` rev
`9b7ceda98c4b0485590c04805c62ebde76e66159` (FluidAudio 0.14.8), before any
feature code was written.

**The premise holds.** Feeding a 4.09 s fixture (16 kHz mono, 41 × 100 ms
chunks) through `streaming_asr_start` → `streaming_asr_feed` → `streaming_asr_finish`:

```
init_streaming_asr OK in 18.51s          (cold: model load + ANE compile)
is_streaming_asr_available: false -> true
fed 65512 samples in 41 chunks, wall 796µs
streaming_asr_finish in 97ms
SESSION TEXT = "I need you to review the pull request before we can merge it into the main branch."
```

Byte-identical to the batch `transcribe_file` result on the same fixture, and
identical again when the chunks were fed at real-time pace (100 ms sleep
between feeds, 4.39 s wall).

**D0 — but sessions do not reset, and the API lies when reused.**

This is the load-bearing finding. `SlidingWindowAsrManager.startStreaming()`
does not clear the previous session's transcript, so the *second* and later
`streaming_asr_finish()` on one manager return the *first* session's text
verbatim, no matter what was fed:

| session (same `FluidAudio`, one `init_streaming_asr`) | fed | returned |
| --- | --- | --- |
| 1 | sentence A | sentence A ✓ |
| 2 | sentence B (different fixture) | **sentence A** ✗ |
| 3 | 3 s of pure silence | **sentence A** ✗ |
| 4 | nothing at all — `start` then `finish` | **sentence A** ✗ |
| 5 | `feed` with no `start` first | **sentence A** ✗ |

A fresh process is correct in every case: silence alone returns `""`, a
different fixture returns its own sentence. And `init_streaming_asr()` *does*
reset it — re-initialising between sessions restored correct per-session
results, and cost 97 ms once the models were already resident (vs 18.5 s cold).

Consequences this design accepts:

- `StreamingAsrSession::finish` **consumes `self`**. A session cannot be
  reused, so the stale-transcript path is unreachable from Kesha's code.
- `StreamingAsrSession::start` calls `init_streaming_asr()` itself rather than
  assuming a warm manager. That is what makes each session independent, and it
  is the reason the fixture-fed test can run several sessions in one process
  and still be meaningful.
- No code path calls `feed` or `finish` without a `start`, because only `start`
  can hand back the type the other two are methods on.

The upstream defect is not fixed here; it is designed around. A comment at the
session type records why, so nobody "simplifies" the constructor into a
one-time init later.

**D0b — no partials.** `streaming_asr_feed` returns `Result<(), FluidAudioError>`.
There is no partial text, no callback, no polling accessor — checked in
`src/lib.rs` and `swift/FluidAudioBridge.swift` at the pinned rev, and at
`0.15.5` (rev `dc931c5`, the `deps/issue-709` bump), where the whole
`MARK: - Streaming ASR` section is unchanged. The ticket's "print partials to
stderr" is therefore out of scope; stderr carries an elapsed-time progress line
instead. Recorded in proposal Non-goals so a reviewer does not read this as an
oversight.

**D0c — stdout was clean, and is silenced anyway.** The spike produced zero
bytes on stdout across every path including the error/edge cases. That matches
#259: FluidAudio's stdout prints are error-path prints, not happy-path ones.
Since a live run emits the transcript on stdout, every FluidAudio call is still
wrapped in `fluid_stdout::with_silenced_stdout`, exactly as `backend/fluidaudio.rs`
does — the absence of noise in one 4-second sample is not a guarantee.

## D1 — Where the live loop lives

`record.rs` already has everything the live path needs: `build_input_stream`
(CPAL, all three sample formats), `mix_frame_to_mono`, `ensure_input_channels`,
`spawn_stdin_stop_thread`, and the stop-condition loop. The live path is a
second entry point in the same module reusing all of it, not a new module and
not a generic "recording sink" abstraction — there are exactly two consumers
and a trait between them would earn nothing.

The CPAL callback keeps doing what it does today: convert and `send` on the
mpsc channel. It never touches FluidAudio. Feeding happens on the main thread
draining that channel, so no ASR work runs on the real-time audio callback.

## D2 — Sample rate: a resampler that lives as long as the session

The bridge hardcodes `AVAudioFormat(sampleRate: 16000)` when it wraps the fed
samples, so audio must reach `streaming_asr_feed` already at 16 kHz. The
default macOS input device typically reports 48 kHz.

`audio::resample_mono` cannot be called per chunk: it constructs a fresh
`rubato` sinc resampler per call and zero-pads the tail, so every chunk
boundary would get a flushed-and-restarted filter — a periodic discontinuity
every few hundred milliseconds, fed straight into a windowing ASR.

So the live path holds **one** resampler for the whole session
(`streaming_asr::StreamResampler`), buffers incoming mono samples, and converts
whole `input_frames_next()` blocks as they become available, keeping the
remainder for the next round. Its parameters are lifted from `resample_mono` so
live and batch audio hit the model through the same filter shape. When the
device is already at 16 kHz, samples pass through untouched.

## D3 — CLI surface

`kesha record --live` — no `--out`. Passing both exits 2 before anything is
spawned, the same shape as `--json` / `--toon` on `transcribe`. `--max-seconds`
and the stdin-EOF stop apply unchanged, so `--live` inherits the existing
stop-recording story for free.

Alternative considered and rejected: `--live` writing *both* the WAV and the
transcript. It doubles the state the loop carries for a combination nobody
asked for, and "without writing an intermediate file" is the point of the
ticket.

## D4 — Gating

Three layers, each doing the job it is placed to do:

1. **Compile time** — the session type exists only under
   `all(feature = "coreml", target_os = "macos")`.
2. **Capabilities** — `record.live` is pushed onto the feature vector under the
   same `cfg`. It is a wire contract, so the flag is absent, not false, on
   builds that cannot serve it.
3. **CLI pre-flight** — `src/cli/record.ts` reads the cached Capabilities JSON
   and refuses `--live` with a message naming the platform requirement before
   spawning. This is the CLAUDE.md rule about not forwarding flags into
   subcommands whose flag set differs.

`--live` stays on the clap surface of every build rather than being `cfg`'d off
it, so a stale CLI that forwards the flag anyway gets
`error [E_UNSUPPORTED_PLATFORM]` naming the two-step alternative instead of a
bare "unexpected argument". That is the same shape `record` already uses to
reject itself on Linux, where the flag also exists and the runtime does not.

## D5 — What the tests can and cannot prove

No agent can speak into a microphone, so the evidence is split deliberately:

- **The ASR path is proven for real.** A Rust test opens a Git LFS fixture,
  chunks it at 100 ms, and drives an actual `StreamingAsrSession`, asserting
  the transcript. It is `#[ignore]`d — it needs cached CoreML Parakeet models
  and an Apple Neural Engine — following the existing precedent at
  `backend/fluidaudio.rs:109`. Run locally with `--run-ignored`; the output is
  in the PR.
- **The mic path is proven by construction, not by sound.** The pieces the live
  loop adds (resampler continuity, flag resolution, capability gating,
  platform rejection) each have unit tests. The CPAL wiring itself is the same
  code the WAV path already uses.
- **The seam between them is a one-command manual check** for the owner:
  `kesha record --live --max-seconds 10`. Stated plainly in the PR rather than
  implied to be covered.

A test-only hook that swaps a WAV file in for the microphone was considered and
rejected: it would put a fake-input branch in the production capture path to
test wiring the unit tests already reach.

## Risks

- **A future refactor re-warming one manager across sessions** silently
  resurrects D0's stale transcripts — and it fails *quietly*, returning
  plausible text. This is the single most dangerous thing in this change. The
  consuming `finish(self)` signature and the comment at the type are the guard.
- **Cold `init_streaming_asr` is ~18 s** on the first live run after boot. It
  happens before capture starts, and stderr says so, so the user is not
  speaking into a void — but it is a real first-run cost.
- **Resampler drift over a long session.** The block-wise loop keeps a
  remainder rather than discarding it, so no samples are dropped at boundaries;
  a length-conservation test covers a multi-block run.

## Open Issues

- Whether `--live` should eventually accept `--out` to keep the WAV as well is
  a real question, deliberately deferred (proposal Non-goals).
- Upstream churn on streaming seams (FluidAudio #825/#830 merge token order,
  #831 EOU debounce) may change transcript joining at a future bump. The
  fixture-fed test is the regression detector: it asserts each session contains
  its own fixture's content *and* not the previous session's.
