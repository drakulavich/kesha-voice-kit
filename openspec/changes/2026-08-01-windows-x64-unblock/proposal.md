# Proposal: windows-x64-unblock

## Why

The CLI refuses to install on Windows x64 with an error naming **v1.5.0** and recommending
"use v1.4.x as a workaround". The repository is on v1.24.7 — the refusal has outlived its
cause by roughly twenty minor versions.

The cause was [issue #216](https://github.com/drakulavich/kesha-voice-kit/issues/216): the
`vosk-tts-rs` transitive native stack mixed static and dynamic MSVC CRTs, so the Engine
would not link on `x86_64-pc-windows-msvc`. That issue was **closed on 2026-04-30** by the
vendoring plan it proposed. Three of its four acceptance criteria are demonstrably met:

- `rust/vendor/vosk-tts/` exists and builds — the vendored crate compiles in every Rust lane.
- `build-engine.yml` carries the `windows-latest` / `x86_64-pc-windows-msvc` row with
  `--features onnx,tts`, and release **v1.24.7 publishes `kesha-engine-windows-x64.exe`
  (63,447,040 bytes) with a sigstore attestation**.
- The Windows row is back in `rust-test.yml`; `test (windows-latest)` runs 393 tests green.

The fourth — "`kesha say --voice ru-vosk-m02` produces a valid WAV on Windows" — was never
verified, and no lane verifies it today: the Windows CI job runs unit and contract tests, not
real synthesis or Transcription. So the Engine ships, the CLI refuses to fetch it, and nobody
knows whether the shipped binary actually speaks.

This proposal removes the stale refusal **and** adds the verification whose absence is the
only honest reason left to keep a gate. Shipping the unblock without it would replace a
false negative with an unverified promise.

## What Changes

- **CLI platform gate**: `getEngineBinaryName` stops throwing for `win32`/`x64` and returns
  the released asset name. Backend auto-detection learns `win32-x64 → onnx`; today it returns
  `undefined`, and the pre-flight check is written `platformBackend && backend !== platformBackend`,
  so `undefined` *skips* validation rather than failing it. Lifting the throw alone would let
  `kesha install --coreml` past the pre-flight on Windows and only reject it after the 63 MB
  download, when `validateBackend` compares the Capabilities JSON.
- **Install plan**: the Windows note claiming the platform is blocked is dropped, so
  `kesha install --plan` stops contradicting itself (it already lists the Windows asset and
  its size).
- **Release verification**: a real-synthesis and real-Transcription smoke lane on
  `windows-latest` (and `ubuntu-latest`, which has the same gap) that synthesises a WAV via
  `kesha say` and feeds it back through Transcription. This closes the last #216 acceptance
  criterion and the `Linux/Windows real-synth release smoke` item already tracked in ROADMAP
  under [#464](https://github.com/drakulavich/kesha-voice-kit/issues/464).
- **Docs**: README platform line, the seven "Blocked at install (#216)" rows and the
  explanatory paragraph in `docs/product-positioning.md`, and the installation spec's Open
  Issue entry.

## Capabilities

### New Capabilities

(none — the change modifies behavior already covered by the `installation` capability)

### Modified Capabilities

- `installation`: Windows x64 becomes a supported install target; Backend auto-detection
  covers it; the platform matrix a reader consults stops describing a block that the
  release artifacts contradict.

## Non-goals

- **No new platform capabilities.** Windows gets exactly what the ONNX Engine already
  compiles: Transcription, Language detection (audio), VAD, and TTS via Kokoro, Vosk, and
  CharsiuG2P. CoreML, `macos-*` voices, Diarization, and Language detection (text) stay
  macOS-only, and this change must not blur those rows.
- **No microphone capture on Windows.** `kesha record` remains macOS-only; Windows users
  pass an existing audio file, as the README already instructs.
- **No Intel-Mac (`darwin-x64`) revival.** That platform has no published Engine and stays
  "not shipped".
- **No change to the Never-auto-download rule.** Unblocking install does not make anything
  download outside an explicit `kesha install`.
- **No engine (Rust) changes.** The Windows Engine already builds and ships; this is a CLI,
  CI, and documentation change.

## Impact

- TS CLI: `src/engine-install.ts::getEngineBinaryName`, `src/cli/install.ts::defaultBackendForPlatform`,
  `src/install-plan.ts::buildEngineComponent` + unit tests.
- CI: a new release-smoke lane; no change to the existing rust-test or build-engine matrices.
- Docs: `README.md`, `docs/product-positioning.md`, `openspec/specs/installation/spec.md`.
- No breaking changes for macOS or Linux: every touched branch is guarded on
  `process.platform === "win32"` and is unreachable elsewhere.
