## MODIFIED Requirements

### Requirement: `--live` requires an Engine that advertises `record.live`

The CLI SHALL read the Engine's describe document for the `record.live` feature before spawning, and SHALL refuse `--live` with `E_INVALID_ARG` and a message naming the platform requirement and pointing at the capture-then-transcribe alternative when that feature is absent from `features`. The flag SHALL NOT be forwarded to an Engine that does not advertise it.

A describe document the CLI cannot read SHALL end the command as a refusal rather than an assumption of support, carrying the `KeshaError` that the failed read produced and a hint naming `kesha install`.

#### Scenario: Maks records live on a CoreML Engine

- GIVEN the installed Engine's describe document lists `record.live` in `features`
- WHEN Maks runs `kesha record --live`
- THEN the CLI forwards `--live` and the live transcription starts
- AND no `E_INVALID_ARG` is reported

#### Scenario: Ira runs `--live` against a Linux ONNX Engine

- GIVEN the installed Engine does not advertise `record.live`
- WHEN Ira runs `kesha record --live`
- THEN the CLI reports `E_INVALID_ARG`, states that live transcription requires a
  CoreML Engine on Apple Silicon, and names `kesha record --out … && kesha …` as
  the way to get a transcript on this platform
- AND the process exits 1 without spawning the Engine

#### Scenario: the describe document cannot be read

- GIVEN the Engine is installed but `kesha-engine describe` fails
- WHEN Maks runs `kesha record --live`
- THEN the CLI refuses rather than forwarding `--live` on the assumption that
  it is supported

> *Technical Note — flag `RECORD_LIVE_FEATURE = "record.live"` at `src/engine.ts:24`, checked by `preflightRecordLive` at `src/engine.ts:481-505`, whose three bare `Error` throws become `KeshaError`; the read moves from `getEngineCapabilities` to `src/engine/describe.ts` and the check folds into the generic `validateArgv`. Mirrors the `transcribe.diarize` gate. The Engine-side `cfg` gate at `rust/src/capabilities.rs:49-53` is the second line of defence: a build without the streaming session rejects `--live` as one `error` event whose `code` is `E_UNSUPPORTED_PLATFORM`, exits 1, and names the two-step alternative — the same shape `record` already uses on Linux.*
