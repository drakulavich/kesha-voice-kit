## ADDED Requirements

### Requirement: The Engine names its release profile

Every Engine binary published on a release SHALL have been built from exactly one of the two profiles `portable` and `darwin`, and its `describe` document SHALL report that profile as `profile`; a release row that names any other feature set SHALL fail the workflow check before a build starts.

#### Scenario: Maks reads which profile his Engine is

- GIVEN the darwin-arm64 Engine from a release
- WHEN the CLI runs `kesha-engine describe`
- THEN `profile` is `"darwin"` and `backend` is `"coreml"`

#### Scenario: A release row drifts from the profiles

- GIVEN a release workflow build row whose `features` is `onnx` without `tts`
- WHEN the workflow lint runs in CI
- THEN it fails naming the row and the two allowed profiles

> *Technical Note — the bundles are `[features] portable` and `darwin` in `rust/Cargo.toml`; `PROFILE` in `rust/src/platform.rs` feeds `describe.rs::document`. The row assertion is `requireReleaseRowsNameOneProfile` in `.github/scripts/check-workflows.ts`, reading the `build` job's matrix in `.github/workflows/build-engine.yml:99-111` (`release.yml` once `unified-release` lands).*
