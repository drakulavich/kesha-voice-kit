# Installation Specification

## Purpose

Installation is how Kesha acquires the Engine binary and all models. `kesha install`
downloads and verifies them explicitly; `kesha init` guides a first-time user through
the same process interactively. Nothing ever downloads automatically — every other
command fails with an actionable hint if a required component is missing. This is the
path Ira relies on in CI pipelines (reproducible, hash-verified, no surprises) and the
path Maks follows when setting up a new machine.

## Non-Goals

- No automatic downloads during transcription, TTS, or any other command
  (Never-auto-download rule). Missing components fail with a `kesha install` hint.
- `kesha install` does not manage the Bun/npm CLI package itself — use
  `bun add -g @drakulavich/kesha-voice-kit` for that.
- No model pruning or cleanup of previously installed optional components; installs
  are additive.
## Requirements
### Requirement: Only `kesha install` downloads the Engine and models

The CLI SHALL download the Engine binary and ASR/lang-id models only when `kesha install`
(or `kesha init` leading to an install) is explicitly invoked. Every other command
(`kesha`, `kesha say`, `kesha doctor`, etc.) SHALL fail immediately with an actionable
error message telling the user to run `kesha install` when a required component is
missing.

#### Scenario: Ira runs transcription before installing

- GIVEN no Engine binary is present in the Model cache
- WHEN Ira runs `kesha standup.ogg`
- THEN the CLI prints an error naming the missing component and including a
  `kesha install` hint to stderr
- AND the process exits 1 without attempting a download

#### Scenario: Maks installs for the first time

- GIVEN no Engine is installed
- WHEN Maks runs `kesha install`
- THEN the Engine binary and required ASR/lang-id models are downloaded and verified
- AND the process exits 0
- AND subsequent `kesha audio.ogg` invocations succeed

> *Technical Note — sources: `src/engine-install.ts::installEngine`,
> `src/cli/install.ts::performInstall`. The Engine binary is fetched from
> `https://github.com/drakulavich/kesha-voice-kit/releases/download/v<version>/<asset>`.
> The version is `package.json#kesha.engine.version`, injected at publish, or
> `package.json#version` in a source checkout (`src/package-info.ts::resolveEngine`). Required models are
> installed by delegating `kesha-engine install` to the Rust binary after the binary
> download completes.*

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
> `src/cli/install.ts::defaultBackendForPlatform` (darwin-arm64 → `coreml`, linux-x64 and
> win32-x64 → `onnx`), `src/engine-install.ts::validateInstallRequest` (post-download
> backend mismatch check against the describe document's `backend`, #1165). The
> pre-flight in `performInstall` only engages when the platform backend is defined, so
> an unshipped platform defers to the post-download check.*

### Requirement: Windows x64 installs the released ONNX Engine

`kesha install` on win32-x64 SHALL download the published Windows Engine asset, install
it at a path the CLI can spawn, and complete the same install flow as linux-x64, with no
platform-specific refusal. The Install plan SHALL describe that platform in the same
terms it uses for the platforms it installs on. Windows receives the ONNX capability set;
CoreML, `macos-*` Voice ids, Diarization, and Language detection (text) SHALL keep
failing there with their existing platform errors.

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

> *Technical Note — sources: `src/engine-install.ts::getEngineBinaryName`,
> `src/engine-install.ts::fetchEngineBinary` (its only caller — reached from
> `installEngine` only when the cached-version check fails), `src/paths.ts::defaultEngineBinPath`
> (`.exe` on win32), `src/install-plan.ts::buildEngineComponent`. Built by
> the `build` job of `.github/workflows/release.yml` from the `portable` profile; issue #216's MSVC link
> failure was resolved by vendoring the Vosk-TTS runtime under `rust/vendor/vosk-tts/`.
> The ONNX capability set is Transcription, Language detection (audio), VAD, and TTS
> through the Kokoro, Vosk, and CharsiuG2P TTS engines. The plan's wording matters
> because a reader must never be told a platform is blocked while the same output lists
> its Engine asset and size. The release asset is a PE, so the installed binary keeps its
> `.exe` suffix rather than the extensionless name used on POSIX platforms.*

### Requirement: Every shipped platform is verified end to end before release

The release pipeline SHALL verify that each stable-Channel platform's built Engine asset performs real synthesis and real Transcription before the release is created, and SHALL refuse to create the release when any platform fails. A platform whose Engine ships without that verification SHALL be documented as unverified. A successful `kesha install` SHALL NOT by itself count as verification. Alpha Engine assets SHALL NOT be presented as verified or change the platform support matrix.

#### Scenario: Smoke on the built asset

- GIVEN the release workflow built the Engine for a platform
- WHEN the smoke job runs on that platform
- THEN it runs `describe`, synthesises through `kesha say`, transcribes the result back
- AND only then does the release job create the GitHub release

#### Scenario: One platform fails the smoke

- GIVEN the linux-x64 asset cannot synthesise
- WHEN the smoke job reports it
- THEN no GitHub release is created and nothing is published
- AND the run names the failing platform

#### Scenario: Engine builds but cannot synthesise

- GIVEN a platform's Engine compiles and its unit tests pass
- AND its synthesis smoke fails
- WHEN Ira consults the platform matrix
- THEN that platform is not presented as supported

#### Scenario: An alpha Engine does not change the support matrix

- GIVEN an Engine alpha is published for a platform
- WHEN Ira consults the platform matrix
- THEN the matrix reflects the stable Channel only
- AND the alpha is not counted as evidence that the platform is supported

#### Scenario: Alpha Engine assets do not gate stable lanes

- GIVEN an Engine alpha has been published more recently than the newest stable Engine
- WHEN a lane that downloads the published Engine runs on an unrelated pull request
- THEN it resolves the stable Engine
- AND the alpha does not affect that lane's outcome

> *Technical Note — verification downloads the just-built asset as a workflow artifact and runs `describe`, `kesha say` and a transcription of the result. A successful `kesha install` does not count because the install-time ASR warm-up is non-fatal by design. Sources: `.github/workflows/release.yml::build` (every row runs `describe`; linux-x64 and windows-x64 synthesise and transcribe back before upload), `.github/workflows/release.yml::roundtrip-smoke` (`.github/scripts/release-install-smoke.sh::run_artifact`: version, `describe`, ASR warm-up, a fixture transcript, a synthesis round trip) and `.github/workflows/release.yml::darwin-synthesis-smoke` (Kokoro and the AVSpeech Sidecar; hosted macOS runners have no Neural Engine, so darwin-arm64 is documented as unverified for Transcription, #678, #742). Two earlier scenarios were retired because verification moved ahead of publication: "Smoke on the published asset" and "Warm-up fails but install reports success" described a cold install of an already-published asset.*

### Requirement: Linux packages ship only from a release that publishes the same CLI version

A `.deb` or `.rpm` SHALL be published only by the stable release whose version it carries, and that release SHALL publish the same version to npm in the same run; a run that attaches the packages without publishing that version SHALL fail rather than ship a package naming a CLI version Ira cannot otherwise install. The packaged version is `package.json#version` at the tag, so the release SHALL refuse a tag whose version differs from it. Prerelease tags SHALL ship no packages.

#### Scenario: Maks installs the CLI from apt

- GIVEN a stable tag `vX.Y.Z` is pushed
- WHEN the release workflow runs
- THEN that release carries the `.deb` and the `.rpm`, listed with the Engine assets in its one `SHA256SUMS`
- AND it publishes `X.Y.Z` to npm in the same run
- AND `X.Y.Z` is the version `package.json` carries at that tag

#### Scenario: The tag names a version the commit does not carry

- GIVEN a tag whose version differs from `package.json#version` at that tag
- WHEN the release workflow classifies it
- THEN it fails before building, naming both versions
- AND no package and no GitHub release is produced

#### Scenario: A Prerelease tag is pushed

- GIVEN a tag on the beta or alpha Channel
- WHEN the release workflow runs
- THEN the packages job is skipped and says why

> *Technical Note — sources: `.github/workflows/release.yml::packages` builds through `.github/actions/linux-packages/action.yml` on the stable Channel before `assemble`, because an immutable release refuses assets after publication; `.github/scripts/release-manifest.mjs::buildManifest` names them and the one `SHA256SUMS` lists them; `.github/scripts/check-workflows.ts::requireReleaseJobOrder` keeps npm downstream of the release that carries them. The earlier scenario "An engine release is cut" was retired: every stable tag now publishes both artifacts.*

### Requirement: TTS install is opt-in and requires `--tts`

The CLI SHALL install TTS models only when `--tts` is passed: bare `--tts` installs
English only and `--tts <lang>…` the listed languages. Language codes given without
`--tts` SHALL fail with `error [E_INVALID_ARG]: …` and exit 2 explaining the required
flag. Unsupported language codes SHALL fail the same way, listing the supported set,
before any download, even under `--plan`. ONNX builds support `en`, `es`,
`fr`, `it`, `pt`, `ru`; darwin-arm64 adds `hi`, `ja`, `zh`. Installs SHALL be additive.

#### Scenario: Ira installs English TTS

- WHEN Ira runs `kesha install --tts`
- THEN the Kokoro-82M model graph (~326 MB) and the `am_michael` voice file are
  downloaded
- AND the process exits 0

#### Scenario: Maks installs English and Russian TTS

- WHEN Maks runs `kesha install --tts en ru`
- THEN Kokoro files for English and Vosk-TTS Russian files (~937 MB total) are
  downloaded
- AND the process exits 0

#### Scenario: Unsupported language code

- GIVEN the machine is linux-x64 (ONNX build)
- WHEN Ira runs `kesha install --tts zh`
- THEN stderr reads `error [E_INVALID_ARG]: Unsupported TTS language(s): zh. …` listing the supported languages for this platform
- AND the process exits 2

#### Scenario: Language codes without the flag

- WHEN Ira runs `kesha install ru`
- THEN stderr reads `error [E_INVALID_ARG]: Language codes (ru) require the --tts flag, …`
- AND the process exits 2 and nothing is downloaded

#### Scenario: Unsupported language code under --plan

- WHEN Maks runs `kesha install --plan --tts xx`
- THEN the same coded line is printed and the process exits 2 with an empty stdout

#### Scenario: Adding Russian keeps English in place

- GIVEN English TTS is already installed
- WHEN Maks runs `kesha install --tts ru`
- THEN the Vosk-TTS Russian files are downloaded
- AND the English Kokoro files are left in place
- AND the process exits 0

> *Technical Note — the positional-code error uses `E_INVALID_ARG` and exit 2 because
> that is the usage class every other argument error shares. "ONNX builds" covers
> linux-x64 and macOS ONNX. Sources: `src/cli/install.ts::resolveTtsLangs`,
> `src/install-plan.ts` (KOKORO_GRAPH_FILE ~325 MB, per-language KOKORO_VOICE_FILES
> ~522 KB each, VOSK_RU_FILES ~937 MB total, G2P_CHARSIU_FILES ~100 MB for es/fr/it/pt
> on ONNX). Supported language list comes from `getEngineCapabilities()` when the
> Engine is already installed; when it is not, `src/cli/install.ts::installableTtsLangs`
> supplies the platform's static set — `["en", "es", "fr", "it", "pt", "ru"]` plus
> `hi`, `ja`, `zh` on darwin-arm64 — so a bad code is rejected before anything downloads.
> The Engine re-validates authoritatively at download time.*

### Requirement: On darwin-arm64, `--tts` stages FluidAudio's Kokoro assets outside the Model cache

On darwin-arm64 `kesha install --tts` SHALL stage every asset first synthesis
would otherwise fetch, verified against the same Pinned hashes as any other
model, into the directories FluidAudio's CoreML/ANE bundles read from rather than
the Model cache. Staging SHALL be additive and idempotent: an asset already
present and matching its Pinned hash is not downloaded again. Russian is
unaffected; Vosk-TTS installs into the Model cache on every platform.

#### Scenario: Maks installs Mandarin TTS on Apple Silicon

- GIVEN the machine is darwin-arm64
- WHEN Maks runs `kesha install --tts zh`
- THEN the Mandarin ANE bundle, the `zh` voice packs, and the pinyin
  dictionaries are downloaded, hash-verified, and staged into FluidAudio's
  Mandarin bundle directory
- AND the process exits 0
- AND a later `kesha say --voice zh-zm_050` synthesizes without downloading
  anything

#### Scenario: Ira installs Spanish TTS on Apple Silicon

- GIVEN the machine is darwin-arm64
- WHEN Ira runs `kesha install --tts es`
- THEN the English ANE model chain with its vocab and bundled voice pack, the `es`
  voice pack, and the shared BART G2P bundle with the Misaki lexicon are downloaded,
  hash-verified, and staged into FluidAudio's directories
- AND the process exits 0
- AND the same asset set is staged for any of `en`, `es`, `fr`, `hi`, `it`, `ja`, `pt`,
  with the requested languages' voice packs

#### Scenario: A second language install leaves the first in place

- GIVEN `kesha install --tts en` has already staged the English chain
- WHEN Maks runs `kesha install --tts zh`
- THEN the English assets are left in place and the Mandarin ones are added
- AND the process exits 0

#### Scenario: Russian-only install stages nothing into FluidAudio

- GIVEN the machine is darwin-arm64
- WHEN Ira runs `kesha install --tts ru`
- THEN the Vosk-TTS files land in the Model cache
- AND no FluidAudio Kokoro asset is downloaded or staged

> *Technical Note — sources: `rust/src/models/download.rs::download_tts` calls
> `stage_fluidaudio_kokoro_assets` (manifests `ANE_EN_FILES`,
> `KOKORO_G2P_FILES`, `ANE_ZH_FILES`, `ANE_ZH_G2P_ASSETS`; the English variant
> serves `ANE_ENGLISH_VARIANT_LANGS` = en/es/fr/hi/it/ja/pt) and
> `stage_ane_kokoro_voices` (`ANE_KOKORO_VOICES`, #475), both under
> `cfg(all(system_kokoro, macos, aarch64))`. Directories:
> `fluidaudio_ane_kokoro_dir()` and `fluidaudio_ane_zh_kokoro_dir()`, which sit
> under `fluidaudio_kokoro_location()`, and `fluidaudio_kokoro_g2p_dir()`,
> pinned because `G2PModel.shared` resolves it itself (fluidaudio-rs 4e488d7,
> still true at upstream 0.15.7). `ANE_ZH_FILES` carries `g2pw/g2pw.mlmodelc`
> because upstream's `requiredModelsZh` checks the whole set before loading
> anything, even though the disambiguator cannot activate at this pin.
> `--plan` and `kesha doctor` preview only the English ANE chain and the
> shared G2P set, via `src/kokoro-ane.ts::kokoroAneComponents`; the Mandarin
> bundle is excluded there on purpose, since `--tts zh` is a separate opt-in
> and its bytes already appear under the cache report's Kokoro ANE root
> (#823, #828, #831). The non-Russian voices on darwin-arm64 are served by
> FluidAudio's CoreML/ANE bundles, which upstream reads from directories of its
> own choosing, which is why staging targets those directories.*

### Requirement: Staged FluidAudio Kokoro assets land where upstream reads them

On darwin-arm64 the staged ANE chain and Mandarin bundle SHALL follow whichever
models root the Engine points FluidAudio at, so relocating the root relocates
them, and the shared G2P assets SHALL be staged to the fixed path upstream's
singleton resolves for itself, which no models root can move.

#### Scenario: Ira installs English TTS into a relocated Model cache

- GIVEN the machine is darwin-arm64 with no Kokoro ANE bundle under FluidAudio's own
  default directory
- AND `KESHA_CACHE_DIR=/Volumes/ci/kesha`
- WHEN Ira runs `kesha install --tts en`
- THEN the English ANE chain is staged under `/Volumes/ci/kesha/fluidaudio`
- AND the shared BART G2P bundle and the Misaki lexicon are staged under
  `~/.cache/fluidaudio/Models/kokoro`
- AND the process exits 0

#### Scenario: Maks moves the Model cache after staging English

- GIVEN English TTS is staged and the shared G2P assets sit at their fixed path
- WHEN Maks points `KESHA_CACHE_DIR` at a new directory and runs `kesha install --tts en`
- THEN the English ANE chain is staged under the new models root
- AND the shared G2P assets stay at their fixed path and are not downloaded again

> *Technical Note — sources: `rust/src/models/paths.rs::fluidaudio_location` (a legacy
> directory that already holds the bundle is kept; otherwise the root is
> `fluidaudio_models_root()`, `<Model cache>/fluidaudio`) and
> `rust/src/models/paths.rs::fluidaudio_kokoro_g2p_dir` (`G2PModel.shared` resolves
> `~/.cache/fluidaudio/Models/kokoro` itself, fluidaudio-rs 4e488d7, still true at
> upstream 0.15.7; staging elsewhere leaves English synthesis failing with
> `G2PModelError.vocabLoadFailed`).*

### Requirement: The pre-synthesis asset check does not require the Mandarin jieba HMM tables

The pre-synthesis asset check SHALL NOT require the Mandarin jieba HMM tables, which
`kesha install --tts zh` deliberately does not stage; their absence degrades Mandarin
segmentation rather than blocking synthesis.

#### Scenario: Maks synthesizes Mandarin without the jieba HMM tables

- GIVEN `kesha install --tts zh` has staged the Mandarin bundle on darwin-arm64
- AND the jieba HMM tables are absent
- WHEN Maks runs `kesha say --voice zh-zm_050 "你好"`
- THEN the asset check reports nothing missing and audio is written
- AND the process exits 0

#### Scenario: A Mandarin install stages no jieba HMM tables

- GIVEN the machine is darwin-arm64
- WHEN Ira runs `kesha install --tts zh`
- THEN no jieba HMM table is downloaded or staged
- AND the process exits 0

> *Technical Note — segmentation falls back to FMM without the tables. The spec has
> recorded them as never published upstream; the comment on
> `rust/src/models/manifest.rs::ANE_ZH_G2P_ASSETS` says upstream first published them
> at this pin (FluidAudio#919) and kesha does not stage them yet.*

### Requirement: VAD and Diarize install are separate opt-in flags

The CLI SHALL install the Silero VAD model only when `--vad` is passed (~2.3 MB).
The CLI SHALL install the Sortformer diarization model only when `--diarize` is passed
(~245 MB). `--diarize` SHALL fail with exit 1 on any platform other than darwin-arm64.

#### Scenario: Ira installs VAD for long-audio CI jobs

- WHEN Ira runs `kesha install --vad`
- THEN the Silero VAD model (~2.3 MB) is downloaded to the Model cache
- AND the process exits 0

#### Scenario: Diarize on a non-darwin-arm64 machine

- GIVEN the machine is linux-x64
- WHEN Ira runs `kesha install --diarize`
- THEN the CLI prints an error that `--diarize` is currently darwin-arm64 only
- AND the process exits 1 without downloading anything

#### Scenario: Maks installs diarization on Apple Silicon

- GIVEN the machine is darwin-arm64
- WHEN Maks runs `kesha install --diarize`
- THEN the Sortformer model files (~245 MB) are downloaded
- AND the process exits 0

> *Technical Note — sources: `src/cli/install.ts::performInstall` (darwin-arm64 guard),
> `rust/src/cli/install.rs::run` (`#[cfg(feature = "system_diarize")]`),
> `src/install-plan.ts` (VAD_FILES ~2.3 MB, DIARIZE_FILES ~245 MB).*

### Requirement: Every model file has a Pinned hash; mismatches are rejected, not cached

The Engine SHALL verify every downloaded model file against its Pinned hash, whether or
not `KESHA_MODEL_MIRROR` is active. A mismatching file SHALL be deleted, SHALL NOT be
left in the Model cache, and the install SHALL fail with an error. The Model mirror
SHALL rewrite only HuggingFace model download URLs, never GitHub release asset URLs
(Engine binary, Sidecars), and SHALL be announced by a banner on stderr before any
download begins.

#### Scenario: Corrupted download is rejected

- GIVEN `KESHA_MODEL_MIRROR` points to a mirror that serves a modified model file
- WHEN Ira runs `kesha install`
- THEN the install fails with an error indicating the hash mismatch
- AND no corrupted file remains in the Model cache

#### Scenario: Mirror banner is shown

- GIVEN `KESHA_MODEL_MIRROR=https://mirror.example.com/models`
- WHEN Maks runs `kesha install`
- THEN a banner noting the active mirror is printed to stderr before downloads begin
- AND all HuggingFace model URLs are rewritten to use the mirror base
- AND the Engine binary URL is not rewritten

> *Technical Note — sources: `rust/src/models/manifest.rs` (SHA-256 per `ModelFile` entry,
> `download_verified` function, `init_mirror_logging`, `model_mirror()`).
> Error code `E_CACHE_CORRUPT` is used when a cached file fails hash verification.*

### Requirement: Downloads land atomically and an installed Engine is verified by running it

The CLI SHALL stream every download into a staging file beside its destination and rename
it into place only once complete; a failed or interrupted download SHALL leave the
previous file untouched, or no file when there was none. `kesha install` SHALL re-download
an Engine whose Recorded Engine version matches but which cannot be spawned, and a cached
Sidecar the OS refuses to execute. A Capabilities probe that fails because the Engine
cannot be spawned SHALL NOT abort the install.

#### Scenario: Maks interrupts a download with Ctrl-C

- GIVEN `kesha install` is downloading the Engine binary
- WHEN Maks presses Ctrl-C partway through
- THEN no partial Engine binary is left at the install path
- AND a previously installed Engine binary is still intact and runnable

#### Scenario: Ira re-runs install over a corrupt Engine

- GIVEN the Engine binary is truncated but its `.version` marker names the pinned version
- WHEN Ira runs `kesha install`
- THEN the CLI reports that the installed Engine does not run and re-downloads it
- AND the command completes without surfacing an `E_ENGINE_SPAWN` failure from the
  Capabilities probe

#### Scenario: Sona runs two installs at once

- GIVEN one `kesha install` is streaming the Engine into its staging file
- WHEN Sona starts a second `kesha install` in another terminal
- THEN the second run leaves the first run's staging file alone
- AND a staging file older than 24 hours is removed instead

> *Technical Note — sources: `src/progress.ts::streamResponseToFile` (stages to
> `<dest>.part.<pid>.<n>` — unique per call, since two concurrent calls in one process
> would share a pid — renames on success, sweeps orphans older than `STALE_STAGING_MS`),
> `src/engine-health.ts::probeExecutable`, `src/engine-install.ts::installEngine`
> (health-gated cache validity; skipped on a read-only engine directory, where nothing
> could be repaired anyway), `src/engine-install.ts::sidecarNeedsDownload`,
> `src/cli/install.ts::probeCapabilitiesForInstall`. Mirrors the staging and the
> age-gated, Unix-only orphan sweep of `rust/src/models/download.rs` (`write_verified`,
> `cleanup_orphan_staging`): Windows keeps last-write time stale while a handle is open,
> so an in-flight download there cannot be told apart from an orphan.*

### Requirement: Orphaned staging files are swept only once they are older than 24 hours

Staging files left behind by a killed process SHALL be swept only once they are older
than 24 hours, so a second `kesha install` running concurrently never deletes the staging
file the first one is still streaming into.

#### Scenario: Maks re-runs install a day after a killed download

- GIVEN a staging file from a killed `kesha install` is older than 24 hours
- WHEN Maks runs `kesha install` on macOS
- THEN the orphaned staging file is removed
- AND the install completes

#### Scenario: A recent staging file survives a second install

- GIVEN a staging file younger than 24 hours sits beside the Engine binary
- WHEN Ira runs `kesha install`
- THEN that staging file is left in place

> *Technical Note — sources: `src/progress.ts` (`STALE_STAGING_MS`, the sweep returns
> early on win32) and `rust/src/models/download.rs::cleanup_orphan_staging`. The sweep is
> Unix-only for the reason in the previous requirement's note.*

### Requirement: Concurrent installs into one Model cache are serialised, and a lock nobody holds is cleared

`kesha install` SHALL take a lock on the Engine directory before writing to it, and SHALL wait for a live holder rather than fail. A lock whose owner record does not parse SHALL be cleared by the next waiter within one poll interval; one that cannot be read at all SHALL be treated as a live holder. A waiter that outlasts the wait ceiling SHALL fail with `E_INSTALL_RACE`, naming the holder when it can and the lock path to delete in every case.

#### Scenario: Ira runs two installs at once against a shared cache

- GIVEN one `kesha install` holds the lock on a shared `KESHA_CACHE_DIR`
- WHEN Ira starts a second `kesha install` in another job
- THEN the second run reports that it is waiting and names the lock to delete if no install is running
- AND it proceeds as soon as the first run releases the lock

#### Scenario: The lock's owner record does not parse

- GIVEN the lock directory holds an owner file that is not valid JSON
- WHEN Maks runs `kesha install`
- THEN the install clears that lock on its first poll and proceeds
- AND it does not wait for the stale ceiling or report `E_INSTALL_RACE`

#### Scenario: The lock's owner record cannot be read

- GIVEN the lock directory holds an owner file the current user has no permission to read
- WHEN Ira runs `kesha install` with `KESHA_INSTALL_LOCK_WAIT_SECS` set
- THEN the install waits out that ceiling and fails with `E_INSTALL_RACE`
- AND the owner file is still there

#### Scenario: The lock directory holds something that is not an owner record

- GIVEN the lock directory holds a file that is not an owner record and no owner file
- WHEN Ira runs `kesha install` with `KESHA_INSTALL_LOCK_WAIT_SECS` set
- THEN the install waits out that ceiling and fails with `E_INSTALL_RACE`
- AND the message says the holder cannot be identified and names the lock path to delete

> *Technical Note — `src/install-lock.ts::acquireInstallLock` (#997) publishes an owner
> file inside a staged directory and renames it into place; `readOwner` returns the owner
> record, the owner file's token with no record when the file does not parse, the token
> marked `unreadable` when the file cannot be read, or null when there is no owner file; `clearLock` unlinks the owner by its exact name and then
> removes the directory. `waitTimedOut` is the `E_INSTALL_RACE` (#1018). Pinned by
> `tests/unit/install-lock.test.ts`. The lock exists so two installs sharing one Model cache
> never overwrite each other. An unreadable owner record counts as a live holder
> because a permission or I/O failure says nothing about the install behind it.*

### Requirement: A lock whose owner is gone is cleared within one poll interval

The next waiter SHALL clear a lock within one poll interval, rather than wait it out, when
its owner is a process on the same host that has exited or has held it past the stale
ceiling.

#### Scenario: The lock's owner exited on this host

- GIVEN the lock's owner record names a process on this host that is no longer running
- WHEN Maks runs `kesha install`
- THEN the install clears that lock on its first poll and proceeds
- AND it does not report `E_INSTALL_RACE`

#### Scenario: The lock's owner runs on another host

- GIVEN the lock's owner record names a process on another host, taken less than the
  stale ceiling ago
- WHEN Ira runs `kesha install` with `KESHA_INSTALL_LOCK_WAIT_SECS` set
- THEN the install waits out that ceiling and fails with `E_INSTALL_RACE` naming that
  holder
- AND the lock is still there

> *Technical Note — an owner on another host cannot be probed, so its death is only known
> once the stale ceiling (`STALE_LOCK_MS`, 6 hours) passes. Sources:
> `src/install-lock.ts` (owner `host` compared with `hostname()`, `pidAlive`).*

### Requirement: `--plan` shows the download plan without changing local state

The CLI SHALL print a human-readable Install plan when `--plan` is passed, listing all
components with their sizes, cache status (cached / needed / refresh), source, and the
expected network bytes for the current run, then warm-up steps and the equivalent
`kesha install …` command. No files SHALL be downloaded or modified. On darwin-arm64 the
FluidAudio Kokoro ANE chain, the shared G2P bundle and each requested language's voice
pack SHALL appear as components sized from the pinned manifest.

#### Scenario: Ira previews a fresh install

- GIVEN no Engine or models are installed
- WHEN Ira runs `kesha install --plan`
- THEN the plan lists Engine, ASR, and lang-id components with sizes, all marked
  `needed`
- AND states `Expected Kesha-managed network for this run` in bytes
- AND ends with `Run: kesha install`
- AND the process exits 0 with no downloads having occurred

#### Scenario: Plan for an Engine release the CLI does not pin

- WHEN Ira runs `kesha install --plan --engine-version 9.9.9-alpha.1`
- THEN the Engine component reads `size unknown`
- AND the totals name it under `Not counted (size unknown)`

#### Scenario: Plan with TTS and VAD

- WHEN Maks runs `kesha install --plan --tts en ru --vad`
- THEN the plan additionally lists TTS Kokoro, TTS Vosk RU, and VAD Silero components
- AND already-cached components are marked `cached`

#### Scenario: Plan for a FluidAudio language that is not staged

- GIVEN darwin-arm64 with English staged and Spanish not
- WHEN Ira runs `kesha install --plan --tts es`
- THEN the plan lists the Spanish voice pack as `needed` with its size
- AND `Expected Kesha-managed network for this run` is that size, not `0 B`

#### Scenario: Plan for a FluidAudio language already staged

- WHEN Ira runs `kesha install --plan --tts en` on the same machine
- THEN the ANE chain and the English pack are marked `cached`
- AND the expected network total is `0 B`

> *Technical Note — sources: `src/install-plan.ts::renderInstallPlan`. The plan is
> rendered entirely client-side from pinned sizes; no network access is required.
> Engine and Sidecar sizes: `src/install-plan.ts::releaseAssetSize`, from the pin
> `.github/scripts/engine-pin.ts::buildEnginePin` injects (openspec unified-release D1).
> Key totals: cold-cache ASR + lang-id ~2.6 GB; VAD ~2.3 MB; Diarize ~245 MB;
> TTS English only ~326 MB; TTS English + Russian ~937 MB. Sizing FluidAudio components
> from the manifest is what makes `--tts <lang>` for an unstaged pack state the bytes it
> will fetch while a staged one counts as cached.*

### Requirement: The Install plan sizes the Engine only from the release the CLI pins

The Install plan SHALL take Engine and Sidecar sizes from the Engine pin injected into
the published package; for a release that pin does not describe (`--engine-version`, or a
source checkout, which carries no pin) it SHALL state their size as unknown and leave
them out of the totals rather than show another release's size.

#### Scenario: Ira previews an install from the published package

- GIVEN Ira installed the CLI package from npm, which carries the Engine pin
- WHEN Ira runs `kesha install --plan`
- THEN the Engine and Sidecar components show the sizes the pin records
- AND those sizes are counted in `Expected Kesha-managed network for this run`

#### Scenario: Maks previews an install from a source checkout

- GIVEN Maks runs the CLI from a source checkout, which carries no Engine pin
- WHEN Maks runs `kesha install --plan`
- THEN the Engine component reads `size unknown`
- AND the totals name it under `Not counted (size unknown)`

> *Technical Note — sources: `src/install-plan.ts::releaseAssetSize`, fed by
> `.github/scripts/engine-pin.ts::buildEnginePin`. The `--engine-version` case is pinned
> by the scenario "Plan for an Engine release the CLI does not pin" above.*

### Requirement: `--no-cache` forces a re-download; silently ignored on read-only engine directories

The CLI SHALL re-download all components when `--no-cache` is passed, even if they
are already cached and hash-valid. On a read-only engine directory (e.g. a Nix store
install), `--no-cache` for the Engine binary SHALL be silently ignored with a log
message; `--no-cache` is still forwarded to the model install step.

#### Scenario: Ira forces a clean re-download

- GIVEN all components are already cached
- WHEN Ira runs `kesha install --no-cache`
- THEN all components are re-downloaded and re-verified
- AND the process exits 0

#### Scenario: Nix store install ignores `--no-cache` for the binary

- GIVEN the Engine binary is on a read-only Nix store path
- WHEN a user runs `kesha install --no-cache`
- THEN a message is printed explaining the Engine directory is read-only and
  `--no-cache` is skipped for the binary
- AND model downloads still proceed (with `--no-cache` applied)

> *Technical Note — sources: `src/engine-install.ts::installEngine`
> (`canWriteEngineDir` check via `fs.accessSync(engineDir, W_OK)`). The Nix flake
> build stages models at build time; `--no-cache` reaching the model step is still
> valid for user-managed cache overrides.*

### Requirement: macOS binaries are ad-hoc codesigned and unquarantined after download

On macOS, the CLI SHALL run `codesign --force --sign -` and
`xattr -d com.apple.provenance` on every downloaded binary (Engine and Sidecars)
after writing them to disk. Both steps are best-effort: if both fail, a manual
recovery hint is printed to stderr. This prevents Gatekeeper SIGKILL on macOS 15+
Sequoia.

#### Scenario: Maks downloads on macOS 15

- GIVEN the machine is darwin-arm64 running macOS 15 Sequoia
- WHEN Maks runs `kesha install`
- THEN the Engine binary and Sidecars are codesigned and unquarantined
- AND `kesha audio.ogg` runs without a Gatekeeper kill

#### Scenario: Both codesign and xattr fail

- GIVEN neither `codesign` nor `xattr` is available
- WHEN the install completes
- THEN the CLI prints a warning with manual `codesign` and `xattr` commands to stderr
- AND the install itself does not fail (the binary is still on disk)

> *Technical Note — sources: `src/engine-install.ts::darwinTrustBinary`. Two
> independent fixes run in sequence: `codesign --force --sign - <path>` re-applies
> the ad-hoc signature; `xattr -d com.apple.provenance <path>` strips the download
> quarantine marker. The xattr step treats exit 1 + "No such xattr" as success.
> darwin-arm64 Sidecars: `say-avspeech` (AVSpeech) and `kesha-textlang` (text
> language detection), downloaded concurrently with the Engine binary.*

### Requirement: Warm-up runs after download; `--no-warmup` skips it; failures are non-fatal

After installing models, the Engine SHALL warm up the ASR Backend once, so its
cold-start cost is paid during install rather than on the first Transcription, and
SHALL compile the Sortformer model to a stable `.mlmodelc` path when `--diarize` is
installed. Warm-up failures SHALL be non-fatal: the install succeeds and a warning is
printed. `--no-warmup` SHALL skip all warm-up. On darwin-arm64 the CLI SHALL also warm
up Kokoro TTS, except when only Russian TTS (`--tts ru`) is requested.

#### Scenario: First install on Apple Silicon

- GIVEN a fresh darwin-arm64 install with no CoreML cache
- WHEN Maks runs `kesha install`
- THEN the ASR warm-up runs and the Engine prints `ASR backend warmed up (dt=<n>ms).`
- AND subsequent `kesha audio.ogg` invocations start without the ANE compile delay

#### Scenario: Warm-up failure does not block install

- GIVEN the CoreML ANE is temporarily unavailable
- WHEN the warm-up step fails
- THEN a warning is printed to stderr explaining the first real invocation will pay
  the cold-start cost
- AND the process still exits 0

#### Scenario: CI install skips warm-up

- WHEN Ira runs `kesha install --no-warmup` in a headless CI image
- THEN no warm-up step runs
- AND the install completes faster

> *Technical Note — cold-start costs: CoreML ANE compile ~20–30 s on darwin-arm64, ORT
> session init ~500 ms on ONNX, first-time Sortformer compile ~1–2 minutes. The ASR
> warm-up instantiates the Backend once. `--no-warmup` is an Engine-level flag the CLI
> forwards. The Kokoro warm-up calls `kesha-engine say` to prime the FluidAudio CoreML
> cache; Russian-only installs skip it because Vosk does not need it.
> Sources: `rust/src/cli/install.rs::run` (`no_warmup` flag,
> `backend::create_backend` warm-up, diarize compile via
> `fa.compile_diarization_model`); `src/engine-install.ts::warmDarwinKokoro`
> (TTS Kokoro warm-up on darwin-arm64, timeout 180 s). Diarize warm-up note:
> the e5rt ANE compile cache is keyed by compiled bundle identity, not path —
> recreating the `.mlmodelc` is still a cache miss (#444).*

### Requirement: `kesha init` is the interactive guided setup

`kesha init` SHALL present an interactive guided setup: a description of optional
features, a multi-select TTS language picker (English pre-checked), yes/no prompts for
VAD and, on darwin-arm64, diarization, then the Install plan and a confirmation before
installing. `--yes` SHALL install the current defaults without prompting, and `--plan`
SHALL print the overview and plan without prompting or downloading. `--diarize` off
darwin-arm64 is dropped with a warning; the install proceeds.

#### Scenario: Maks runs guided setup on Apple Silicon

- GIVEN the machine is darwin-arm64 with a TTY
- WHEN Maks runs `kesha init`
- THEN the CLI displays available optional features, prompts for TTS language
  selection (English pre-checked), prompts for VAD and diarization
- AND shows the Install plan for the selected components
- AND asks for confirmation before starting the download

#### Scenario: Ira runs init in a CI pipeline (no TTY)

- GIVEN stdin is not a TTY
- WHEN Ira runs `kesha init`
- THEN the CLI prints `error [E_INVALID_ARG]: kesha init is interactive and needs a terminal`
  on stderr, with a hint naming `kesha init --yes` and `kesha init --plan`
- AND exits 2 without blocking on a prompt, printing nothing on stdout or downloading anything

#### Scenario: `--yes` for scripted install with defaults

- WHEN Ira runs `kesha init --yes --tts`
- THEN the CLI runs `kesha install --tts` immediately with no interactive prompts
- AND exits 0 on success

#### Scenario: `--diarize` dropped on non-darwin-arm64

- GIVEN the machine is linux-x64
- WHEN Ira runs `kesha init --yes --diarize`
- THEN a warning is printed: `--diarize is currently darwin-arm64 only; omitting it`
- AND the install proceeds without the diarize model

#### Scenario: Maks presses Ctrl-C at a prompt

- GIVEN Maks runs `kesha init && kesha meeting.ogg` in a TTY
- WHEN Maks presses Ctrl-C at the TTS language picker
- THEN the CLI prints `Init cancelled.` and exits 130
- AND nothing is downloaded
- AND `kesha meeting.ogg` does not run

> *Technical Note — sources: `src/cli/init.ts::initCommand`,
> `src/cli/init.ts::promptInitSelection`, `src/cli/init.ts::canInstallDiarizeOnPlatform`. The TTS language picker uses
> `@clack/prompts::multiselect` with `required: false` (no-selection = skip TTS).
> TTY check: `process.stdin.isTTY === true && process.stdout.isTTY === true`.
> A cancelled clack prompt returns `isCancel`'s sentinel rather than throwing;
> `src/cli/init.ts::exitIfCancelled` turns it into `process.exit(130)`. Pinned by
> `tests/unit/init.test.ts` (S4-F1).*

### Requirement: `kesha init` refuses to prompt without a terminal

`kesha init` SHALL refuse with `E_INVALID_ARG` (exit 2) when stdin or stdout is not a TTY
and neither `--yes` nor `--plan` is given, with a hint naming `kesha init --yes` and
`kesha init --plan`, print nothing on stdout, and download nothing, so it never hangs
waiting for interactive input.

#### Scenario: Ira previews setup in a CI pipeline

- GIVEN stdin is not a TTY
- WHEN Ira runs `kesha init --plan`
- THEN the overview and the Install plan are printed without any prompt
- AND the process exits 0 and nothing is downloaded

#### Scenario: Maks pipes init's output into a log

- GIVEN stdin is a TTY and stdout is piped
- WHEN Maks runs `kesha init | tee init.log`
- THEN stderr carries `error [E_INVALID_ARG]: kesha init is interactive and needs a terminal`
- AND the process exits 2 with nothing on stdout and nothing downloaded

> *Technical Note — sources: `src/cli/init.ts::initCommand` (`--plan` and `--yes` return
> before the TTY check).*

### Requirement: Cancelling a `kesha init` prompt exits 130

Cancelling any `kesha init` prompt (Ctrl-C or Escape) SHALL end it with `Init cancelled.`
and exit 130, downloading nothing, so a chained `kesha init && …` does not continue as
though setup had succeeded.

#### Scenario: Maks presses Escape at the confirmation

- GIVEN Maks has made his selections in `kesha init` and the Install plan is shown
- WHEN Maks presses Escape at the confirmation prompt
- THEN the CLI prints `Init cancelled.` and exits 130
- AND nothing is downloaded

#### Scenario: Ira presses Ctrl-C at the VAD prompt

- GIVEN Ira runs `kesha init && kesha say "ready"` in a TTY
- WHEN Ira presses Ctrl-C at the VAD prompt
- THEN the CLI exits 130 without downloading anything
- AND `kesha say` does not run

> *Technical Note — 130 is the same code an interrupted `kesha install` reports. Source:
> `src/cli/init.ts::exitIfCancelled`.*

### Requirement: The star prompt is gated to meaningful version bumps and bounded in time

After a successful install the CLI MAY print an invitation to star the repository, and SHALL show it only on a first install or a major/minor bump — never on a patch-only bump — and SHALL bound how long it waits on any external probe before printing. The prompt is cosmetic and SHALL never fail the install: any error it raises — a failed probe, spawn, or logger — is swallowed and the install still exits 0.

#### Scenario: Maks installs for the first time

- GIVEN Maks has never installed Kesha
- WHEN `kesha install` finishes successfully
- THEN the invitation is printed once
- AND running `kesha install` again for the same version prints nothing

#### Scenario: Ira upgrades by a patch version in CI

- GIVEN a previous install recorded version `1.28.0`
- WHEN Ira installs `1.28.1`
- THEN no invitation is printed, because a patch bump is not a meaningful bump

#### Scenario: The environment cannot be probed

- GIVEN `gh` is absent, unauthenticated, or wedged
- WHEN the invitation would be shown
- THEN the plain invitation is printed anyway, without waiting indefinitely on
  the probe
- AND the install still exits 0

#### Scenario: The marker cannot be written

- GIVEN the engine directory is read-only, so the marker write fails
- WHEN the invitation would be shown
- THEN nothing is printed and the install still succeeds, because the prompt is
  skipped when it cannot be recorded, so a read-only directory never nags

#### Scenario: The star prompt throws after a completed install

- GIVEN the engine and models are downloaded and verified on disk
- AND the star prompt raises — `Bun.which`, either `gh` spawn, or the logger throws
- WHEN `maybeAskForStar` runs
- THEN the throw is swallowed to a warning, the install is recorded as
  `success`, and the CLI exits 0

#### Scenario: The repository is already starred

- GIVEN an authenticated `gh` reports the repository is already starred
- WHEN the invitation would be shown
- THEN nothing is printed, and the slot is still consumed so the same version
  never asks again

> *Technical Note — `src/star.ts::maybeAskForStar` is called after
> `installEngine` succeeds, from `src/cli/install.ts::performInstall`.
> `src/star.ts::shouldShowStarPrompt` returns true for an absent marker
> and for a major-or-minor increase only. The marker is `<engine-bin>.star-seen`
> (`src/star.ts::starSeenPath`) and is written *before* printing, so one run never
> prompts twice and a write failure is non-fatal.
> `src/star.ts::GH_PROBE_TIMEOUT_MS` is 2 000 ms, sized to clear a healthy
> `gh auth status` (0.77–1.21 s
> measured) but not a wedged one that blocked install 11–25 s (#810).
> `maybeAskForStar` is total: its whole body sits in a try that swallows any
> throw to `log.warn`, so a failing probe, spawn, or logger cannot escape into
> `performInstall`'s catch (#936). A marker-write failure returns without
> printing, so a read-only engine directory is silently skipped rather than
> nagging every install. Covered by `tests/unit/star.test.ts`.*

### Requirement: Install cost is stated before download
User-facing install documentation SHALL state the approximate download/disk cost of `kesha install` (~2.7 GB) and the quiet-progress behavior of the model step next to the command itself, and SHALL present `kesha install --plan` (exact sizes, downloads nothing) and `kesha status --disk` as the user-facing cost-inspection commands.

#### Scenario: reading Quick Start
- **WHEN** a new user reads the README Quick Start install step
- **THEN** the expected download size, disk footprint, and the `--plan` preview command are visible without leaving the section

### Requirement: Documented install entry points match interactive hints
Interactive missing-model errors recommend `kesha init`; the Quick Start SHALL mention `kesha init` and state its relationship to `kesha install` so the hint never names an undocumented command.

#### Scenario: user follows an interactive hint
- **WHEN** a TTY user sees "run `kesha init`" after a missing-model error and searches the README
- **THEN** the README explains what `kesha init` is and that it is interchangeable with `kesha install`

## Open Issues

- `kesha record` has no Windows or Linux microphone capture; `record.rs` gates capture on
  macOS and the README directs other platforms to pass an existing audio file.
- The spec has said the Mandarin jieba HMM tables were never published upstream, while
  the comment on `rust/src/models/manifest.rs::ANE_ZH_G2P_ASSETS` says FluidAudio#919
  published them at the current pin and kesha does not stage them yet. Whether to stage
  them is undecided.
