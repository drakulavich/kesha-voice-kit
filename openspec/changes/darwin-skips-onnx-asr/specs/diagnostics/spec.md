## ADDED Requirements

### Requirement: Diagnostics report ASR from the Backend's real location

`kesha status --disk` and `kesha doctor` SHALL report the ASR component from wherever the
compiled Backend keeps its weights. On a CoreML Engine that is FluidAudio's external cache,
reported separately from Kesha's Model cache — the same treatment the FluidAudio Kokoro cache
already receives, and for the same reason.

A healthy install SHALL NOT be rendered as missing ASR because a diagnostic points at a
directory the platform no longer populates.

#### Scenario: Maks checks disk usage on Apple Silicon

- GIVEN a healthy CoreML install on darwin-arm64
- WHEN Maks runs `kesha status --disk`
- THEN the ASR row reports FluidAudio's external cache, marked as external like the Kokoro row
- AND no row claims ASR is missing

#### Scenario: Maks runs doctor after installing

- GIVEN the same install
- WHEN Maks runs `kesha doctor`
- THEN the ASR check passes
- AND its reported path is the one his Backend actually reads

#### Scenario: the external ASR cache is genuinely absent

- GIVEN a CoreML install where FluidAudio's cache has not been populated yet
- WHEN Maks runs `kesha doctor`
- THEN ASR is reported as not yet fetched, with the action that populates it
- AND the report does not name the ONNX path, which is not what this platform uses

> *Technical Note — sources: `src/status.ts:150` and `src/doctor.ts:209`, which both hardcode
> `models/parakeet-tdt-v3`. The FluidAudio ASR bundle path is not a guess: `AsrModels`
> resolves `defaultCacheDirectory(for: .v3)` → `MLModelConfigurationUtils.defaultModelsDirectory`
> = `<ApplicationSupport>/FluidAudio/Models/<repo.folderName>`, and `folderName` strips the
> `-coreml` suffix from `Repo.parakeetV3` (`parakeet-tdt-0.6b-v3-coreml`), giving
> **`~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3`** (473 MB measured).
> A sibling `…-v3-coreml` directory also exists on this machine; nothing in the current version
> resolves to it, so the check must not key on it. The existing Kokoro precedent is
> `models::fluidaudio_ane_kokoro_dir`, which points at the separate TTS root `~/.cache/fluidaudio`
> — upstream keeps ASR/VAD/diarization and TTS in two different roots by design
> (`ModelHub.clearAllCaches`).*
