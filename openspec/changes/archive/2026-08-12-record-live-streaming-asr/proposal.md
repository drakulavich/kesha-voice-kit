## Why

Getting a transcript from the microphone takes two commands and a temp file today:

```
kesha record --out /tmp/note.wav --max-seconds 30
kesha /tmp/note.wav
```

The Engine already links a streaming ASR session API through `fluidaudio-rs`
(`init_streaming_asr` / `streaming_asr_start` / `streaming_asr_feed` /
`streaming_asr_finish`), so the microphone samples the recorder is already
mixing to mono can be fed straight into it. The WAV in the middle buys nothing
when the user only wanted the text.

The API was validated end-to-end against the pinned `fluidaudio-rs`
(rev `9b7ceda`, FluidAudio 0.14.8) before this proposal — a chunked 4.09 s
fixture fed through `start` → `feed` × 41 → `finish` returned the correct
sentence, matching the batch path verbatim. See design.md for what the spike
found, including the upstream session-reuse defect that shapes the API here.

## What Changes

- `kesha record --live` transcribes the default microphone as it is captured
  and prints the transcript to stdout when recording stops. No WAV is written.
- `--live` and `--out` are mutually exclusive; each invocation is either a
  capture or a live transcription, never both.
- The Engine advertises `record.live` in `--capabilities-json` only on builds
  that can serve it (CoreML, macOS). The CLI checks that flag before spawning
  and refuses with an actionable message otherwise — no blind flag forwarding.
- Everything about `kesha record --out` is untouched: same WAV, same stop
  conditions, same stderr summary.

## Capabilities

### New Capabilities

None. `record.live` is a new feature flag on an existing capability, not a new
capability directory.

### Modified Capabilities

- `audio-recording`: gains a live transcription mode alongside capture-to-WAV,
  and the flag validation that keeps the two apart.
- `engine-contract`: gains the `record.live` feature flag and the CLI-side
  pre-flight that reads it.

## Non-goals

- **Partial transcripts.** The ticket sketches printing partials to stderr as
  they arrive. The bound surface does not carry them: `streaming_asr_feed`
  returns `Result<()>` with no text, and the Swift bridge exposes no partial
  callback — at the pinned rev *and* at `0.15.5` on the `deps/issue-709`
  branch, whose streaming section is byte-identical. Nothing is printed
  incrementally; a progress line reports elapsed capture time instead. Adding
  partials requires an upstream bridge change and is its own issue.
- **Non-CoreML live transcription.** ONNX builds keep record-then-transcribe.
  Wiring the ONNX encoder into a streaming window is a separate, larger change.
- **VAD interaction.** Streaming ASR does its own windowing, so the VAD path is
  bypassed rather than stacked. `--vad` is not accepted on `record`, and this
  change does not add it.
- **Device selection, `--out` plus `--live` together, or writing the transcript
  to a file.** Redirect stdout.
- **Bumping `fluidaudio-rs`.** The pinned rev serves this feature; the bump on
  `deps/issue-709` (#755) changes nothing in the streaming path.

## Impact

- Engine: `rust/src/streaming_asr.rs` (new, CoreML+macOS only),
  `rust/src/record.rs` (live capture loop next to the WAV one),
  `rust/src/cli/record.rs`, `rust/src/main.rs`, `rust/src/capabilities.rs`.
- CLI: `src/cli/record.ts` (flag resolution + pre-flight), `src/engine.ts`
  (`RECORD_LIVE_FEATURE`, `recordEngine` gains the live spawn shape).
- Users on Apple Silicon get a one-command path from speech to text. Every
  other platform sees an unchanged `kesha record` and a clear error on `--live`.
- The microphone path itself cannot be exercised by CI or by an agent. The ASR
  half is covered by feeding a fixture through a real streaming session; the
  mic half is covered by unit tests around the pieces plus one manual check.

Closes #711.
