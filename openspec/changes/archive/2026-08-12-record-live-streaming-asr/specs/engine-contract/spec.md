## ADDED Requirements

### Requirement: `record.live` is advertised only by Engines that can serve it

The Engine SHALL include `record.live` in the `features` array of
`--capabilities-json` when, and only when, it was compiled with the CoreML
backend on macOS. On every other build the flag SHALL be absent from the array
rather than present-and-false, matching how the feature vector already treats
`transcribe.diarize` and `detect-text-lang`.

#### Scenario: Maks probes a CoreML Engine on Apple Silicon

- WHEN Maks runs `kesha-engine --capabilities-json`
- THEN `features` contains `"record.live"` alongside `"transcribe"`
- AND `backend` is `"coreml"`

#### Scenario: Ira probes the Linux ONNX Engine

- WHEN Ira runs `kesha-engine --capabilities-json` on the Linux build
- THEN `features` does not contain `"record.live"`
- AND the JSON is otherwise unchanged from today

> *Technical Note — the push is gated on
> `#[cfg(all(feature = "coreml", target_os = "macos"))]` in
> `rust/src/capabilities.rs`, mirroring the runtime gate exactly so the
> advertisement cannot outlive the code path. `protocolVersion` stays 3:
> adding a feature string is additive and the existing flag-checking contract
> covers it.*
