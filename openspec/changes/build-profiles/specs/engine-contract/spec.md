## ADDED Requirements

### Requirement: The Engine names its release profile

The `describe` document SHALL carry `profile`, whose value is `portable` or `darwin`, and every Engine binary published on a release SHALL have been built from exactly one of those two profiles; a release row that names any other feature set SHALL fail the workflow check before a build starts.

#### Scenario: Maks reads which profile his Engine is

- GIVEN the darwin-arm64 Engine from a release
- WHEN the CLI runs `kesha-engine describe`
- THEN `profile` is `"darwin"` and `backend` is `"coreml"`

#### Scenario: A release row drifts from the profiles

- GIVEN a release workflow build row whose `features` is `onnx` without `tts`
- WHEN the workflow lint runs in CI
- THEN it fails naming the row and the two allowed profiles

> *Technical Note — `PROFILE` in `rust/src/platform.rs`; the row assertion joins `.github/scripts/check-workflows.ts` and reads the release workflow's build rows wherever they live — `.github/workflows/build-engine.yml:106-117` today, `release.yml` once `unified-release` lands.*
