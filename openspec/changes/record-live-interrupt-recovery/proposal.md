## Why

`kesha record --live` streams the microphone into an in-memory
`StreamingAsrSession` and prints the transcript only when recording stops. If
the process dies before that — Ctrl-C, SIGTERM, a crash, a caller's timeout —
**both the audio and the transcript are gone**, with nothing on disk to retry
against. `--out` never had this shape: whatever was captured is in the WAV and
transcription is a separate, repeatable step.

The failure is silent and total, and it lands after the user has already done
the work. It also gets worse the more the flag succeeds at its purpose: `--live`
is most attractive for long dictation, which is exactly where the most is lost.

Two consumers make it concrete. Raycast (#947) plans to adopt `--live` and its
sessions are user-cancellable by design, with a whole SIGTERM/SIGKILL ladder;
and any scripted caller wrapping the command in a timeout hits the same thing.

This is not the "nothing was said" case, which is already specified: silence
exits 0 with empty stdout and a stderr note. This is an interruption partway
through real speech.

## What Changes

Two independent safety nets, because they fail in different ways:

- **The session finishes on SIGINT/SIGTERM instead of dying.** The Engine
  catches both, stops capture, drains and finishes the streaming session, prints
  the transcript it has to stdout as usual, and exits `128 + signal`. A
  cancellation now yields the words spoken up to that moment.
- **The audio is spilled to a recovery WAV while it streams.** This is what
  survives what a handler cannot — `SIGKILL`, a panic, power loss. The file is
  written incrementally with its RIFF sizes refreshed roughly once a second, so
  a hard kill leaves readable audio rather than a header claiming zero samples.
  It is removed when the transcript prints normally, and kept (and named on
  stderr) whenever the session did not end normally.

The happy path's contract is unchanged: on a normal stop `--live` still prints
the transcript to stdout and leaves no file behind.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `audio-recording`: gains the interrupt-recovery contract for `--live` — what
  survives a cancellation, where the recovery audio lands, and the exit code.

## Non-goals

- **Partial transcripts as they arrive.** Still impossible at the bound surface:
  `streaming_asr_feed` returns `Result<()>` and the Swift bridge exposes no
  partial callback (see `record-live-streaming-asr`'s D0b). Finishing the
  session on a signal is what makes the prefix reachable.
- **Relaxing `--live` / `--out` exclusivity.** The recovery WAV is not an output
  the user asked for; it is a spill that normally deletes itself. `--out` stays
  the way to keep the audio deliberately.
- **Recovering from SIGKILL with a transcript.** A killed process cannot print;
  the recovery WAV is the answer there.
- **The unbounded sample channel (#952), engine process registration (#939) and
  the exit-code documentation (#940).** Each is its own ticket. This change
  emits 130/143 correctly but does not document the engine's exit codes.

## Impact

- Engine: `rust/src/record.rs` (spill writer, interrupt handler, live loop),
  `rust/src/cli/record.rs` (exit code).
- CLI: `src/engine.ts` — a live run that stopped on a signal is a success, not a
  failure to report under a transcript that arrived intact.
- Disk: a spill costs ~192 KB/s at a 48 kHz device, bounded by `--max-seconds`
  and deleted on a normal stop. Spills older than 7 days are pruned at session
  start.
- The microphone path still cannot be exercised by CI. The spill writer, the
  pruner and the interrupt handler are unit-tested; the end-to-end cancellation
  is a manual check.

Closes #962.
