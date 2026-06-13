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

> *Technical Note — sources: `src/engine-install.ts::downloadEngine`,
> `src/cli/install.ts::performInstall`. The Engine binary is fetched from
> `https://github.com/drakulavich/kesha-voice-kit/releases/download/v<version>/<asset>`.
> The version is pinned in `package.json#keshaEngine.version`. Required models are
> installed by delegating `kesha-engine install` to the Rust binary after the binary
> download completes.*

### Requirement: Backend selection is mutex and platform-validated

The CLI SHALL accept `--coreml` and `--onnx` flags to override the auto-detected
backend. Passing both SHALL fail immediately with exit 1. Requesting a backend that
does not match the platform's release Engine (e.g. `--coreml` on Linux) SHALL also
fail with exit 1.

Auto-detection defaults: darwin-arm64 → CoreML; linux-x64 → ONNX. Any other
platform is unsupported and fails.

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

> *Technical Note — sources: `src/cli/install.ts::resolveBackendFlag`,
> `src/cli/install.ts::defaultBackendForPlatform`,
> `src/engine-install.ts::downloadEngine` (post-download backend mismatch check via
> Capabilities JSON). Windows x64 is temporarily unsupported in the current release
> (issue #216).*

### Requirement: TTS install is opt-in and requires `--tts`

The CLI SHALL install TTS models only when `--tts` is passed. Bare `--tts` installs
English only. `--tts <lang>…` installs the listed languages. Positional language codes
without `--tts` SHALL fail with exit 1 explaining the required flag. Unsupported
language codes SHALL fail with exit 1 listing the supported set.

The supported TTS language sets are:
- ONNX build (linux-x64, macOS ONNX): `en`, `es`, `fr`, `it`, `pt`, `ru`
- darwin-arm64 (CoreML): additionally `hi`, `ja`, `zh`

Installs are additive; re-running `kesha install --tts ru` on a system with English
already installed leaves English in place.

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

#### Scenario: Language code without `--tts` flag

- WHEN Ira runs `kesha install ru`
- THEN the CLI prints an error: language codes require the `--tts` flag, e.g.
  `kesha install --tts ru`
- AND the process exits 1 without downloading anything

#### Scenario: Unsupported language code

- GIVEN the machine is linux-x64 (ONNX build)
- WHEN Ira runs `kesha install --tts zh`
- THEN the CLI prints an error listing supported languages for this platform
- AND the process exits 1

> *Technical Note — sources: `src/cli/install.ts::resolveTtsLangs`,
> `src/install-plan.ts` (KOKORO_GRAPH_FILE ~325 MB, per-language KOKORO_VOICE_FILES
> ~522 KB each, VOSK_RU_FILES ~937 MB total, G2P_CHARSIU_FILES ~30 MB for es/fr/it/pt
> on ONNX). Supported language list comes from `getEngineCapabilities()` when the
> Engine is already installed; falls back to `TTS_LANG_FALLBACK` = `["en", "es", "fr",
> "it", "pt", "ru"]` when the Engine is not yet installed (hi/ja/zh excluded as they
> require darwin-arm64 capabilities to confirm).*

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

The Engine SHALL verify the SHA-256 hash of every downloaded model file against the
Pinned hash recorded in `rust/src/models.rs`. A file whose hash does not match SHALL
be deleted and the install SHALL fail with an error. The file SHALL NOT be left in the
Model cache.

Activating `KESHA_MODEL_MIRROR` rewrites HuggingFace model download URLs to a
user-supplied base URL; GitHub release asset URLs (Engine binary, Sidecars) are never
rewritten. Hash verification applies identically whether the mirror is active or not.
When `KESHA_MODEL_MIRROR` is set, a banner is printed to stderr before any downloads
begin.

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

> *Technical Note — sources: `rust/src/models.rs` (SHA-256 per `ModelFile` entry,
> `download_verified` function, `init_mirror_logging`, `model_mirror()`).
> Error code `E_CACHE_CORRUPT` is used when a cached file fails hash verification.*

### Requirement: `--plan` shows the download plan without changing local state

The CLI SHALL print a human-readable Install plan when `--plan` is passed, listing all
components with their sizes, cache status (cached / needed / refresh), source, and the
expected network bytes for the current run. No files SHALL be downloaded or modified.
The plan also includes warm-up steps and ends with the equivalent `kesha install …`
command.

#### Scenario: Ira previews a fresh install

- GIVEN no Engine or models are installed
- WHEN Ira runs `kesha install --plan`
- THEN the plan lists Engine, ASR, and lang-id components with sizes, all marked
  `needed`
- AND states `Expected Kesha-managed network for this run` in bytes
- AND ends with `Run: kesha install`
- AND the process exits 0 with no downloads having occurred

#### Scenario: Plan with TTS and VAD

- WHEN Maks runs `kesha install --plan --tts en ru --vad`
- THEN the plan additionally lists TTS Kokoro, TTS Vosk RU, and VAD Silero components
- AND already-cached components are marked `cached`

> *Technical Note — sources: `src/install-plan.ts::renderInstallPlan`. The plan is
> rendered entirely client-side from pinned sizes; no network access is required.
> Key totals: cold-cache ASR + lang-id ~2.6 GB; VAD ~2.3 MB; Diarize ~245 MB;
> TTS English only ~326 MB; TTS English + Russian ~937 MB.*

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

> *Technical Note — sources: `src/engine-install.ts::downloadEngine`
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

After installing models, the Engine SHALL warm up the ASR Backend by instantiating it
once, so the expensive cold-start cost (CoreML ANE compile ~20–30 s on darwin-arm64;
ORT session init ~500 ms on ONNX) is paid during install rather than on the first
transcription. When `--diarize` is installed, the Sortformer model is also compiled to
a stable `.mlmodelc` path (first-time compile ~1–2 minutes). Warm-up failures are
non-fatal: the install still succeeds and a warning is printed.

Passing `--no-warmup` (an Engine-level flag forwarded by the CLI) skips all warm-up.

On darwin-arm64, the CLI also runs a separate Kokoro TTS warm-up by calling
`kesha-engine say` to prime the FluidAudio CoreML cache. This is skipped when only
Russian TTS (`--tts ru`) is requested (Vosk does not need it).

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

> *Technical Note — sources: `rust/src/cli/install.rs::run` (`no_warmup` flag,
> `backend::create_backend` warm-up, diarize compile via
> `fa.compile_diarization_model`); `src/engine-install.ts::warmDarwinKokoro`
> (TTS Kokoro warm-up on darwin-arm64, timeout 180 s). Diarize warm-up note:
> the e5rt ANE compile cache is keyed by compiled bundle identity, not path —
> recreating the `.mlmodelc` is still a cache miss (#444).*

### Requirement: `kesha init` is the interactive guided setup

`kesha init` SHALL present an interactive guided setup for new users: a description
of optional features, a multi-select TTS language picker (English pre-checked), a
yes/no prompt for VAD, and a yes/no prompt for diarization (darwin-arm64 only). After
selection, it shows the Install plan and asks for confirmation before running the
install.

`--yes` accepts all current defaults non-interactively and runs the install
immediately. `--plan` prints the overview and plan without prompting or downloading.

When stdin or stdout is not a TTY, `kesha init` prints the overview, plan, and a set
of suggested `kesha install` commands instead of prompting — it never hangs waiting
for interactive input.

`--diarize` on a non-darwin-arm64 platform is silently dropped with a warning; the
install proceeds without it.

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
- THEN the CLI prints the overview, a representative install plan, and a list of
  suggested `kesha install` commands
- AND exits 0 without blocking on a prompt

#### Scenario: `--yes` for scripted install with defaults

- WHEN Ira runs `kesha init --yes --tts`
- THEN the CLI runs `kesha install --tts` immediately with no interactive prompts
- AND exits 0 on success

#### Scenario: `--diarize` dropped on non-darwin-arm64

- GIVEN the machine is linux-x64
- WHEN Ira runs `kesha init --yes --diarize`
- THEN a warning is printed: `--diarize is currently darwin-arm64 only; omitting it`
- AND the install proceeds without the diarize model

> *Technical Note — sources: `src/cli/init.ts::initCommand`,
> `src/cli/init.ts::promptInitSelection`, `src/cli/init.ts::runNonInteractive`,
> `src/cli/init.ts::canInstallDiarizeOnPlatform`. The TTS language picker uses
> `@clack/prompts::multiselect` with `required: false` (no-selection = skip TTS).
> TTY check: `process.stdin.isTTY === true && process.stdout.isTTY === true`.*

## Open Issues

- `kesha install --tts zh` on a darwin-arm64 machine without the Engine installed
  falls back to `TTS_LANG_FALLBACK` (which excludes `zh`) and rejects the request;
  the error message says "unsupported" rather than "install the engine first to
  unlock platform-specific languages" — see the `resolveTtsLangs` fallback path.
- Windows x64 is temporarily unsupported in the current release (issue #216) due to
  native Vosk-TTS link-time issues; `kesha install` fails with an explanatory error.
