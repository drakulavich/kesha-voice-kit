## ADDED Requirements

### Requirement: The written-form pass is advertised and validated, never forwarded blind

Capabilities JSON SHALL advertise the Engine's support for the written-form Transcription
pass, and the CLI SHALL validate the request against Capabilities JSON before spawning the
Engine.

An Engine that does not advertise it SHALL cause the request to fail with the action that
resolves it, on every Transcription path — not only the timestamped one.

#### Scenario: Sona inspects a current Engine

- GIVEN an Engine built from this change
- WHEN Sona reads its Capabilities JSON
- THEN the feature list contains the written-form pass entry
- AND it is present regardless of which Backend the Engine was compiled with

#### Scenario: Ira runs a new CLI against an Engine installed months ago

- GIVEN an installed Engine whose Capabilities JSON omits the entry
- WHEN Ira transcribes with the written-form pass requested
- THEN the command fails before the Engine is spawned
- AND the message names upgrading the Engine as the action

#### Scenario: the stale Engine is used without the pass

- GIVEN the same installed Engine
- WHEN Ira transcribes without requesting the pass
- THEN Transcription succeeds as before

> *Technical Note — feature string `transcribe.itn`, declared once as
> `TRANSCRIBE_ITN_FEATURE` in `rust/src/transcribe/mod.rs` beside
> `TRANSCRIBE_SEGMENTS_FEATURE` and pushed unconditionally in
> `rust/src/capabilities.rs:34`, mirrored in `src/engine.ts:15`. Unlike
> `transcribe.diarize` this is not Backend-gated: the pass is pure Rust and behaves
> identically on CoreML and ONNX, so the gate exists for Engine-version skew only.
> The check is hoisted above the `timestamps || speakers` short-circuit in
> `src/transcribe.ts:42`, because the pass is meaningful with plain text output.*
