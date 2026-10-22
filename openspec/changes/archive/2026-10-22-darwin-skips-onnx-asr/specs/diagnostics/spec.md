## ADDED Requirements

### Requirement: Diagnostics report ASR from the Backend's real location

`kesha status --disk` and `kesha doctor` SHALL report ASR from where the compiled Backend keeps its weights. On a CoreML Engine that is FluidAudio's tree: its part inside the Kesha cache is one row, and what stays in FluidAudio's own directories is listed under external caches. A healthy install SHALL NOT be shown as missing ASR because a row points at a directory the Backend never populates.

#### Scenario: Maks checks disk usage on Apple Silicon

- GIVEN a healthy CoreML install on darwin-arm64
- WHEN Maks runs `kesha status --disk`
- THEN the cache breakdown has a `FluidAudio (in cache)` row and no `ASR (Parakeet)` row
- AND no row claims ASR is missing

#### Scenario: Maks runs doctor with ONNX weights left over

- GIVEN a CoreML install whose Kesha cache still holds `models/parakeet-tdt-v3` from an older install
- WHEN Maks runs `kesha doctor`
- THEN that directory is listed as `ASR (Parakeet), unused by this engine, safe to delete` with its size
- AND it is not reported as the ASR model the Engine uses

#### Scenario: Ira runs doctor on Linux

- GIVEN an ONNX install on linux-x64
- WHEN Ira runs `kesha doctor`
- THEN the cache breakdown has an `ASR (Parakeet)` row
- AND no `FluidAudio (in cache)` row

> *Technical Note — sources: `src/cache-layout.ts::cacheComponents`, which both commands
> use and which swaps the ONNX rows for the CoreML rows by backend;
> `src/fluid-asr-cache.ts::isCoremlBackend`, which falls back to the platform's shipped
> backend when the describe probe yields nothing, so darwin is never pointed at the ONNX
> directory (#684); external roots from `src/fluid-roots.ts::fluidExternalRoots`. FluidAudio
> loads ASR from `<ApplicationSupport>/FluidAudio/Models/parakeet-tdt-0.6b-v3` when it is
> not relocated; `folderName` strips the `-coreml` suffix, so the `…-v3-coreml` sibling
> some machines carry is not what it reads. Covered by `tests/unit/doctor.test.ts` and
> `tests/unit/status.test.ts`.*
