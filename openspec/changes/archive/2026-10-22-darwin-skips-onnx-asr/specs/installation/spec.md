## ADDED Requirements

### Requirement: Install downloads only what the compiled Backend can use

`kesha install` SHALL download the ASR weights of the Backend compiled into the Engine, and SHALL NOT download the weights of the other Backend: the two Backends are compile-time exclusive with no runtime fallback, so weights for the absent one can never be read. On a CoreML Engine the ASR weights are fetched by FluidAudio, not by Kesha's pinned downloader.

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

> *Technical Note — sources: `rust/src/models/manifest.rs` (the ONNX ASR manifest is
> compiled out of coreml builds), `rust/src/models/paths.rs::fluidaudio_asr_location`
> (FluidAudio's bundle sits under `<Model cache>/fluidaudio` since #688, or in
> FluidAudio's own Application Support tree when it already holds a complete bundle) and
> `fluidaudio_asr_ready_in`, which requires every file FluidAudio's `modelsExist` checks,
> so a partial fetch fails preflight instead of downloading the rest mid-transcribe
> (#684).*

## MODIFIED Requirements

### Requirement: Install cost is stated before download

User-facing install documentation SHALL state the approximate download and disk cost of `kesha install` for each Backend, and the quiet-progress behavior of the model step, next to the command itself, and SHALL present `kesha install --plan` (exact sizes, downloads nothing) and `kesha status --disk` as the cost-inspection commands. `--plan` SHALL quote the compiled Backend's own set and SHALL name weights the Backend fetches outside Kesha's pinned downloader rather than omit them.

#### Scenario: reading Quick Start

- **WHEN** a new user reads the README Quick Start install step
- **THEN** the expected download size, disk footprint, and the `--plan` preview command are visible without leaving the section

#### Scenario: previewing the plan on Apple Silicon

- GIVEN Maks is on darwin-arm64
- WHEN he runs `kesha install --plan`
- THEN the plan does not list the Parakeet ONNX bundle as a download
- AND it lists `ASR Parakeet TDT v3 (CoreML)` with its approximate size, noted as fetched by the backend during warm-up
- AND nothing is downloaded

> *Technical Note — sources: `src/install-plan.ts` (the CoreML row and
> `FLUID_ASR_CACHE_NOTE` from `src/fluid-asr-cache.ts`; the ONNX `ASR_FILES` bundle only
> on an ONNX Engine) and the README Quick Start, which states ~2.5 GB on Linux and
> Windows and ~0.6 GB on Apple Silicon.*
