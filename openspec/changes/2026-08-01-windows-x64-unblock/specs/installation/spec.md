## MODIFIED Requirements

### Requirement: Backend selection is mutex and platform-validated

The CLI SHALL accept `--coreml` and `--onnx` flags to override the auto-detected
backend. Passing both SHALL fail immediately with exit 1. Requesting a backend that
does not match the platform's release Engine (e.g. `--coreml` on Linux) SHALL also
fail with exit 1.

Auto-detection defaults: darwin-arm64 → CoreML; linux-x64 → ONNX; win32-x64 → ONNX. Any
other platform is unsupported and fails.

#### Scenario: Both flags given

- WHEN Ira runs `kesha install --coreml --onnx`
- THEN the CLI prints `Choose only one backend: "--coreml" or "--onnx".` to stderr
- AND the process exits 1 without downloading anything

#### Scenario: Wrong backend for platform

- GIVEN the machine is linux-x64 (ONNX release)
- WHEN Ira runs `kesha install --coreml`
- THEN the CLI prints an error explaining the platform uses the ONNX backend
- AND the process exits 1

#### Scenario: Auto-detection on darwin-arm64

- GIVEN the machine is darwin-arm64 and `--coreml`/`--onnx` are not passed
- WHEN Maks runs `kesha install`
- THEN the CoreML Engine binary is downloaded
- AND no backend error is emitted

#### Scenario: Auto-detection on win32-x64

- GIVEN the machine is win32-x64 and `--coreml`/`--onnx` are not passed
- WHEN Ira runs `kesha install` on a Windows build agent
- THEN the ONNX Engine binary is downloaded
- AND no backend error is emitted

#### Scenario: CoreML requested on Windows

- GIVEN the machine is win32-x64
- WHEN Ira runs `kesha install --coreml`
- THEN the CLI prints an error explaining the platform uses the ONNX backend
- AND the process exits 1

> *Technical Note — sources: `src/cli/install.ts::resolveBackendFlag`,
> `src/cli/install.ts::defaultBackendForPlatform` (returns `undefined` for win32 today; the
> caller guards on `platformBackend && backend !== platformBackend`, so `undefined` skips the
> pre-flight rather than failing it — `--coreml` on Windows is currently caught only after the
> Engine downloads), `src/engine-install.ts::validateBackend` (that post-download mismatch check,
> via Capabilities JSON). The scenario above requires the pre-flight to reject, so
> `defaultBackendForPlatform` must return `onnx` for win32-x64, not merely stop returning
> `undefined`.*

## ADDED Requirements

### Requirement: Windows x64 installs the released ONNX Engine

`kesha install` on win32-x64 SHALL download the published Windows Engine asset and
complete the same install flow as linux-x64, with no platform-specific refusal. The
Install plan SHALL describe that platform in the same terms it uses for the platforms
it installs on, so a reader is never told a platform is blocked while the same output
lists its Engine asset and size.

The capability set Windows receives is the ONNX one: Transcription, Language detection
(audio), VAD, and TTS through the Kokoro, Vosk, and CharsiuG2P TTS engines. Capabilities
that require Apple frameworks — CoreML, `macos-*` Voice ids, Diarization, and Language
detection (text) — remain unavailable there and SHALL keep failing with their existing
platform errors.

The Engine SHALL be installed at a path the CLI can spawn on Windows. `defaultEngineBinPath`
returns an extensionless `kesha-engine`, and the Windows release asset is a `.exe`; the install
SHALL NOT depend on an unverified assumption that an extensionless PE is spawnable.

#### Scenario: Installing on a Windows build agent

- GIVEN the machine is win32-x64 with no Engine in the Model cache
- AND `KESHA_ENGINE_BIN` is not set, so the download path is the one under test
- WHEN Ira runs `kesha install --tts en`
- THEN the Windows Engine binary and the requested TTS models are downloaded
- AND the installed binary is spawnable at the path the CLI resolves
- AND `kesha say "hello"` writes a playable WAV

#### Scenario: Requesting a macOS-only capability on Windows

- GIVEN the machine is win32-x64 with the Engine installed
- WHEN Ira runs `kesha install --diarize`
- THEN the CLI prints an error stating Diarization requires darwin-arm64
- AND the process exits 1

#### Scenario: Previewing the install before downloading

- GIVEN the machine is win32-x64
- WHEN Ira runs `kesha install --plan`
- THEN the plan lists the Windows Engine asset with its size and cache status
- AND the plan contains no statement that the platform is blocked

> *Technical Note — sources: `src/engine-install.ts::getEngineBinaryName` (throws for
> win32-x64 today, naming v1.5.0 while the repository is on v1.24.7),
> `src/engine-install.ts::fetchEngineBinary:386` (its only caller — reached from
> `downloadEngine:527` only when the cached-version check fails, so an Engine already present
> with a matching `.version` marker never touches the gate),
> `src/install-plan.ts::engineAssetForPlatform` (already returns
> `kesha-engine-windows-x64.exe`) and `src/install-plan.ts::buildEngineComponent` (attaches
> the "blocked" note). The asset is published: release v1.24.7 carries
> `kesha-engine-windows-x64.exe` (63,447,040 bytes) plus its sigstore attestation, built by
> `.github/workflows/build-engine.yml` with `--features onnx,tts`.*

### Requirement: Every shipped platform is verified end to end before release

For each platform whose Engine is published, the release pipeline SHALL verify that the
shipped binary performs real synthesis and real Transcription — not only that it builds
and passes unit tests. A platform whose Engine ships without that verification SHALL be
documented as unverified rather than presented as supported.

Verification SHALL cover both the asset a user downloads today and the artifact a release is
about to publish. These are different binaries reached by different means: a release branch
cannot download its own Engine, because its tag does not exist until the release is un-drafted.

#### Scenario: Release smoke on a shipped platform

- GIVEN the release pipeline has built the Windows and Linux Engine binaries from source
- WHEN the smoke lane runs on the release branch
- THEN each locally built binary synthesises audio through `kesha say` and transcribes the
  result back
- AND a failure in either direction fails the release

#### Scenario: Smoke on the published asset

- GIVEN release v`<engineVersion>` publishes an Engine asset for a platform
- WHEN the published-asset smoke lane runs on that platform
- THEN it downloads that asset, synthesises through `kesha say`, and transcribes the result back
- AND the lane does not run on `release/*` branches, whose tag is not yet published

#### Scenario: Engine builds but cannot synthesise

- GIVEN a platform's Engine compiles and its unit tests pass
- AND its synthesis smoke fails
- WHEN Ira consults the platform matrix
- THEN that platform is not presented as supported

> *Technical Note — sources: `.github/workflows/rust-test.yml` (the `test` matrix covers
> macos-14 and windows-latest with unit and contract tests only; the Kokoro and Vosk model
> caches feed gated tests that do not assert audio output),
> `.github/workflows/build-engine.yml` (builds and publishes all three assets). The gap is
> already tracked as `Linux/Windows real-synth release smoke` in `ROADMAP.md` under
> [#464](https://github.com/drakulavich/kesha-voice-kit/issues/464).*

## Open Issues

- The last acceptance criterion of closed issue #216 — `kesha say --voice ru-vosk-m02`
  producing a valid WAV on Windows — has never been demonstrated. The Windows Engine has
  shipped in every release since the vendoring landed, but no lane exercises synthesis or
  Transcription there, so its runtime behavior is unknown rather than known-good. This
  change proposes the verification; until it passes, the install unblock should not merge.
- Whether `kesha record` should gain Windows microphone capture is out of scope here and
  unresolved: `record.rs` gates capture on macOS, and the README directs Linux and Windows
  users to pass an existing audio file. The platform matrix and this spec both continue to
  treat recording as macOS-only.
- The install-time warm-up step's behavior on Windows is undocumented. `InstallArgs::no_warmup`
  describes warm-up as "~500 ms on the ONNX path (Linux/Windows)", which implies Windows was
  considered, but no run has confirmed it. Note that warm-up runs by default yet is deliberately
  non-fatal (`rust/src/cli/install.rs:74-84` warns and continues), so a green install on Windows
  is not evidence the warm-up succeeded — the smoke lane has to assert on the warning line.
- Whether an extensionless `kesha-engine` written by `fetchEngineBinary` is spawnable on Windows
  is unverified, and no smoke lane that sets `KESHA_ENGINE_BIN` can answer it, because that
  override points at a real `.exe`. Only the cold-install job settles it.
