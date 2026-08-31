## ADDED Requirements

### Requirement: Install downloads only what the compiled Backend can use

`kesha install` SHALL download the ASR weights of the Backend compiled into the Engine, and
SHALL NOT download the weights of the other Backend. The two Backends are compile-time
exclusive with no runtime fallback, so weights for the absent Backend can never be read.

On a CoreML Engine the ASR weights are managed by FluidAudio in its own external cache; Kesha
SHALL NOT mirror them into the Model cache.

#### Scenario: Maks installs on Apple Silicon

- GIVEN Maks is on darwin-arm64, whose released Engine is CoreML
- WHEN he runs `kesha install`
- THEN the Parakeet ONNX weight set is not downloaded
- AND Language ID, VAD and any requested TTS models are downloaded as before

#### Scenario: Ira installs on Linux

- GIVEN Ira is on a platform whose released Engine is ONNX
- WHEN she runs `kesha install`
- THEN the Parakeet ONNX weight set is downloaded, unchanged from before

#### Scenario: Transcription still refuses when its models are absent

- GIVEN an installed Engine whose ASR weights are not present
- WHEN Maks transcribes a file
- THEN the CLI fails with an actionable install hint rather than downloading anything silently

## MODIFIED Requirements

### Requirement: Install cost is stated before download

User-facing install documentation SHALL state the approximate download/disk cost of
`kesha install` and the quiet-progress behavior of the model step next to the command itself,
and SHALL present `kesha install --plan` (exact sizes, downloads nothing) and
`kesha status --disk` as the user-facing cost-inspection commands.

The stated cost SHALL match what the running platform will actually download. Because the two
Backends download different ASR weights, a single blanket figure SHALL NOT be presented as if it
applied everywhere; `--plan` SHALL quote the compiled Backend's own set, and SHALL name any
weights fetched by the Backend outside the Model cache rather than omitting them.

#### Scenario: reading Quick Start

- **WHEN** a new user reads the README Quick Start install step
- **THEN** the expected download size, disk footprint, and the `--plan` preview command are visible without leaving the section

#### Scenario: previewing the plan on Apple Silicon

- GIVEN Maks is on darwin-arm64
- WHEN he runs `kesha install --plan`
- THEN the plan does not list the Parakeet ONNX bundle as a download
- AND the ASR weights his Backend will fetch are named, with their approximate size
- AND nothing is downloaded

> *Technical Note — sources: `src/install-plan.ts` (`asr: ASR_FILES`, `modelBundle("ASR Parakeet
> TDT v3", …)`), `rust/src/models/mod.rs::install` (no backend branch today),
> `rust/src/backend/mod.rs::create_backend` (`let _ = model_dir` on the coreml arm).*
