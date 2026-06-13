# Engine Contract Specification

## Purpose

The Engine (`kesha-engine`) is a self-contained Rust binary downloaded during
`kesha install` and invoked by the CLI as a subprocess — never linked
in-process. This spec defines the boundary between the CLI and the Engine: the
Capabilities JSON protocol, the error-code taxonomy and stderr format, the
`KESHA_*` environment variables that both sides honour, and the rule that the
CLI validates flags against Capabilities JSON instead of forwarding them
blindly. Ira depends on stable exit codes and error codes in scripts. Sona
depends on the capabilities contract to feature-gate her agent code. Maks
depends on the Engine being available and well-behaved on his Apple Silicon Mac.

## Non-Goals

- This spec does not cover the internals of ASR inference, TTS synthesis, or
  model download; those are Engine implementation details.
- The Engine's audio decode pipeline (symphonia + rubato) is not specified here.
- Model hash pinning and download mechanics are covered in the installation
  spec.

## Requirements

### Requirement: The Engine is always a subprocess, never linked in-process

The CLI SHALL spawn `kesha-engine` as a child process via `Bun.spawn`. It SHALL
never import or `require` Engine code. The Engine binary path comes from
`KESHA_ENGINE_BIN` when set, otherwise from the default location inside the
Model cache (`~/.cache/kesha/`).

#### Scenario: Ira overrides the engine binary for testing

- GIVEN `KESHA_ENGINE_BIN=/tmp/kesha-engine-dev` is set in the environment
- WHEN Ira runs any `kesha` command that spawns the Engine
- THEN the CLI uses the binary at `/tmp/kesha-engine-dev` instead of the
  cached default

#### Scenario: Engine not installed

- GIVEN the Engine binary does not exist at the resolved path
- WHEN Ira runs `kesha standup.ogg`
- THEN the CLI prints an actionable error with a `kesha install` hint
- AND exits 1 without attempting to spawn a missing binary

> *Technical Note — `getEngineBinPath()` in `src/engine.ts:46` returns
> `process.env.KESHA_ENGINE_BIN ?? defaultEngineBinPath()`.
> `isEngineInstalled()` at `src/engine.ts:50` uses `existsSync`.*

### Requirement: `--capabilities-json` describes the Engine's feature set

Running `kesha-engine --capabilities-json` SHALL print a single-line JSON
object to stdout (protocol version 3) and exit 0. The object contains:

- `protocolVersion`: `3` (integer constant).
- `backend`: `"coreml"` on Apple Silicon builds, `"onnx"` on all others.
- `features`: array of capability-flag strings (see Technical Note below for
  the full set and their compile-time gates).
- `tts`: present only on `tts`-feature builds; an object with `languages` — an
  array of `{ code, engines }` objects, one per supported TTS language, with
  the default engine first.

The CLI caches the Capabilities JSON in-process keyed by binary path and
`mtimeMs`; the cache invalidates automatically when `kesha install` overwrites
the binary.

#### Scenario: Sona probes capabilities before calling `say`

- GIVEN the Engine is a `tts`-feature build
- WHEN the CLI calls `getEngineCapabilities()`
- THEN the result has `protocolVersion: 3` and `features` contains `"tts"`
- AND `tts.languages` contains at least `{ code: "en", engines: ["kokoro"] }`
  and `{ code: "ru", engines: ["vosk"] }`

#### Scenario: CoreML backend on Apple Silicon

- GIVEN an `aarch64-apple-darwin` Engine binary
- WHEN the CLI calls `getEngineCapabilities()`
- THEN `backend` is `"coreml"`

#### Scenario: Engine with no subcommand prints usage and exits 1

- WHEN Ira runs `kesha-engine` with no arguments
- THEN stderr contains `Usage: kesha-engine <command>`
- AND the process exits 1

> *Technical Note — Capability flag strings and their compile-time gates
> (`rust/src/capabilities.rs:37`):*
>
> | Flag | Gate |
> |---|---|
> | `"transcribe"` | always |
> | `"transcribe.segments"` | always |
> | `"detect-lang"` | always |
> | `"vad"` | always |
> | `"detect-text-lang"` | `target_os = "macos"` |
> | `"tts"` | `feature = "tts"` |
> | `"tts.ru_acronym_expansion"` | `feature = "tts"` |
> | `"tts.en_acronym_expansion"` | `feature = "tts"` |
> | `"tts.ru_emphasis_marker"` | `feature = "tts"` |
> | `"tts.prosody_rate"` | `feature = "tts"` |
> | `"transcribe.diarize"` | `feature = "system_diarize"` + `target_os = "macos"` |
>
> `protocolVersion: 3` asserted in `rust/src/capabilities.rs:128`.
> Cache in `src/engine.ts:356`; invalidates when `mtimeMs` changes.*

### Requirement: The CLI validates flags against Capabilities JSON instead of forwarding blindly

Before spawning the Engine for a capability-gated operation, the CLI SHALL
check the relevant feature flag in the cached Capabilities JSON. It SHALL NOT
forward flags to subcommands that do not accept them.

Specifically: `kesha-engine install` accepts only `--no-cache` (plus
`--tts`/`--vad`/`--diarize`/`--no-warmup`); the CLI must not forward
transcription or TTS flags to the install subcommand. `--speakers` requires
`transcribe.diarize` in `features`; the CLI throws a clear error when the flag
is unavailable instead of letting the Engine reject it.

#### Scenario: Diarization requested on a non-diarize build

- GIVEN the Engine does not advertise `transcribe.diarize` in its features
- WHEN Ira calls `transcribe("meeting.ogg", { speakers: true })`
- THEN the CLI throws with a message stating diarization is darwin-arm64 only
- AND no Engine subprocess is spawned

#### Scenario: Unknown flag not forwarded to install

- GIVEN the CLI's install command is invoked
- WHEN the CLI constructs the Engine argv for `kesha-engine install`
- THEN the argv contains only `install` plus at most
  `--no-cache`, `--tts <langs>`, `--vad`, `--diarize`, `--no-warmup`
- AND no CLI-level flags (e.g. `--format`, `--lang`) appear in the Engine argv

> *Technical Note — `preflightTranscribeEngineWithSegments` in
> `src/engine.ts:193` checks `TRANSCRIBE_DIARIZE_FEATURE` against capabilities
> before building the argv. Engine install argv is constructed in
> `src/engine-install.ts`; the CLAUDE.md rule "DO NOT BLINDLY FORWARD CLI FLAGS
> TO SUBCOMMANDS" is the governing design constraint.*

### Requirement: `--error-codes-json` prints the full error-code taxonomy

Running `kesha-engine --error-codes-json` SHALL print a JSON array to stdout
and exit 0. Each element SHALL be an object with `code` (string), `title`
(string), `category` (lowercase string), and `retryable` (boolean).

The taxonomy SHALL contain exactly 19 codes. Only `E_MODEL_DOWNLOAD` and
`E_DIARIZE_TIMEOUT` SHALL be marked retryable.

The CLI SHALL read error codes from Engine stderr using the regex
`/^error \[([A-Z0-9_]+)\]:/m`; when no match is found, it SHALL fall back to
`E_INTERNAL`. The drift test in the test suite verifies that the TS-native code
registry and the Engine taxonomy do not diverge.

#### Scenario: Ira inspects the taxonomy from a script

- WHEN Ira runs `kesha-engine --error-codes-json`
- THEN stdout is a JSON array of exactly 19 objects
- AND each object has `code`, `title`, `category`, and `retryable` fields
- AND the process exits 0

#### Scenario: Only retryable codes are model-download and diarize-timeout

- WHEN Ira parses the `--error-codes-json` output
- THEN exactly `E_MODEL_DOWNLOAD` and `E_DIARIZE_TIMEOUT` have `retryable: true`
- AND all other 17 codes have `retryable: false`

> *Technical Note — Full E_* taxonomy (`rust/src/errors.rs:12`):*
>
> | Code | Category | Retryable | Title |
> |---|---|---|---|
> | `E_INPUT_NOT_FOUND` | input | no | Input file not found |
> | `E_BAD_AUDIO` | input | no | Unreadable or unsupported audio |
> | `E_INVALID_ARG` | input | no | Invalid command-line argument |
> | `E_MODEL_MISSING` | model | no | Model or voice not installed |
> | `E_MODEL_DOWNLOAD` | model | **yes** | Model download failed |
> | `E_CACHE_CORRUPT` | model | no | Cached model failed verification |
> | `E_MODEL_LOAD` | model | no | Model failed to load |
> | `E_UNSUPPORTED_PLATFORM` | platform | no | Feature unsupported on this platform |
> | `E_SIDECAR_MISSING` | platform | no | Helper sidecar missing or failed |
> | `E_NO_BACKEND` | platform | no | No ASR backend compiled in |
> | `E_TEXT_EMPTY` | tts | no | Empty synthesis text |
> | `E_TEXT_TOO_LONG` | tts | no | Synthesis text too long |
> | `E_VOICE_UNKNOWN` | tts | no | Unknown voice id |
> | `E_SSML_INVALID` | tts | no | Malformed SSML |
> | `E_SSML_UNSUPPORTED` | tts | no | SSML not supported for this engine |
> | `E_SCRIPT_UNSUPPORTED` | tts | no | Text script not supported for this voice |
> | `E_TRANSCRIBE_FAILED` | transcribe | no | Transcription failed |
> | `E_DIARIZE_TIMEOUT` | transcribe | **yes** | Speaker diarization timed out |
> | `E_INTERNAL` | internal | no | Unexpected internal error |
>
> `extractEngineErrorCode` regex: `src/error-codes.ts:9`.
> Fallback to `E_INTERNAL` in `engineErrorCode` at `src/error-codes.ts:42`.*

### Requirement: Engine stderr format is `error [E_CODE]: <message>`

When the Engine encounters a fatal error it SHALL print a single line to stderr
in the form `error [E_CODE]: <human-readable message>` and exit 1. The `E_CODE`
token consists only of uppercase letters, digits, and underscores.

The CLI extracts the code with the regex `^error \[([A-Z0-9_]+)\]:` applied
multiline to the captured stderr. Non-fatal warnings (e.g. VAD hints, model
mirror notices) may also appear on stderr; they do not carry the `error [...]`
prefix.

#### Scenario: Missing model produces a parseable error code

- GIVEN the ASR model is not installed
- WHEN Ira runs `kesha standup.ogg`
- THEN stderr contains a line matching `error [E_MODEL_MISSING]: ...`
- AND the CLI surfaces `E_MODEL_MISSING` to the user
- AND the process exits 1

#### Scenario: Engine stderr with no error code

- GIVEN the Engine crashes without printing an `error [...]` line
- WHEN the CLI captures stderr
- THEN `engineErrorCode(stderr)` returns `"E_INTERNAL"`

> *Technical Note — `report` in `rust/src/errors.rs:200` calls
> `eprintln!("error [{}]: {:#}", code.as_str(), err)` and always returns exit
> code 1. Exception: the `say` subcommand maps structured TTS errors through
> `exit_code_for_tts_err` (`rust/src/cli/say.rs:132-136`) to exit codes 2
> (empty text), 4 (synthesis/SSML/internal), and 5 (text too long) — see the
> tts-synthesis spec. All other Engine fatal exits go through `report` or
> `process::exit(errors::report(&err))`.*

### Requirement: TS-native codes cover CLI-side failures

The CLI SHALL define four TS-native error codes for failures that occur before
or around the Engine (never inside it):

- `E_INPUT_NOT_FOUND` — input file not found (checked by the CLI before spawn).
- `E_ENGINE_SPAWN` — Engine binary not installed or failed to start.
- `E_INVALID_ARG` — invalid argument detected by the CLI.
- `E_INTERNAL` — unexpected internal error in the CLI.

These codes SHALL appear in `SayError.code` and in structured error records. A
drift test SHALL verify that every value in `KNOWN_TS_CODES` also appears in
the Engine taxonomy (or is explicitly TS-only).

#### Scenario: Engine binary missing surfaces E_ENGINE_SPAWN

- GIVEN the Engine binary is absent
- WHEN Sona calls `await say({ text: "hello" })`
- THEN `SayError.code` is `"E_ENGINE_SPAWN"` (the value of
  `TS_NATIVE_CODES.ENGINE_SPAWN`)

> *Technical Note — `TS_NATIVE_CODES` at `src/error-codes.ts:18`.
> `KNOWN_TS_CODES` at `src/error-codes.ts:39`. `SayError` default code
> `"E_INTERNAL"` in `src/synth.ts:103`; engine-spawn path uses
> `TS_NATIVE_CODES.ENGINE_SPAWN` at `src/synth.ts:131`.*

### Requirement: `KESHA_*` environment variables configure both CLI and Engine

Both the CLI and the Engine SHALL honour the `KESHA_*` environment variables
listed below. The CLI SHALL read them at startup; the Engine SHALL read them at
spawn time (inheriting `process.env` from the CLI).

> *Technical Note — Full `KESHA_*` env var table:*
>
> | Variable | Read by | Effect |
> |---|---|---|
> | `KESHA_ENGINE_BIN` | CLI | Override Engine binary path (`src/engine.ts:47`). |
> | `KESHA_CACHE_DIR` | CLI + Engine | Override Model cache root (default `~/.cache/kesha/`). CLI: `src/paths.ts:5`. Engine: `rust/src/models.rs:614`. |
> | `KESHA_MODEL_MIRROR` | Engine | Rewrite HuggingFace download base URLs; GitHub release URLs are never rewritten. Safe because of Pinned hashes (`rust/src/models.rs:628`). |
> | `KESHA_DEBUG` | CLI + Engine | Enable debug trace output. Falsey values: `""`, `"0"`, `"false"`, `"no"`, `"off"` (case-insensitive). Truthy: any other non-empty value. CLI: `src/log.ts:30`. Engine: `rust/src/debug.rs:57`. |
> | `KESHA_DEBUG_FD` | CLI + Engine | Forward a file descriptor number to the Engine for NDJSON debug event output. Values 0/1/2 are rejected (covered by stdin/stdout/stderr). Values above 1024 (`MAX_FORWARDED_FD`) are rejected. Must be a non-negative integer ≥ 3. CLI: `src/engine.ts:92`. Engine: `rust/src/debug.rs:159`. |
> | `KESHA_DIARIZE_TIMEOUT_SECS` | Engine | Override the adaptive diarization timeout (seconds). CLI checks `KESHA_DIARIZE_MODEL_PATH` before spawn. Engine: `rust/src/transcribe/diarize.rs:103`. |
> | `KESHA_DIARIZE_MODEL_PATH` | CLI + Engine | Override the Sortformer model path. CLI: `src/engine.ts:212`. Engine: `rust/src/transcribe/mod.rs:747`. |
> | `KESHA_STATS_DB` | CLI | Override the Stats DB path (`src/stats.ts:580`). |
> | `KESHA_LOG_DIR` | CLI | Override the Diagnostic log directory (`src/diagnostic-log.ts:73`). |

#### Scenario: Ira points the cache at a network share in CI

- GIVEN `KESHA_CACHE_DIR=/mnt/ci-cache/kesha` is set
- WHEN Ira runs `kesha standup.ogg`
- THEN the CLI resolves the Engine binary from `/mnt/ci-cache/kesha/`
- AND the Engine reads models from `/mnt/ci-cache/kesha/models/`

#### Scenario: KESHA_DEBUG_FD rejects stdin/stdout/stderr numbers

- WHEN `KESHA_DEBUG_FD=1` is set
- THEN `spawnStdioWithDebugFd` returns the base stdio array unchanged (fd 1 is
  rejected)
- AND no extra fd is forwarded to the Engine

#### Scenario: KESHA_DEBUG_FD rejects out-of-range values

- WHEN `KESHA_DEBUG_FD=2000` is set
- THEN `spawnStdioWithDebugFd` returns the base stdio array unchanged
  (2000 > `MAX_FORWARDED_FD` = 1024)

> *Technical Note — `MAX_FORWARDED_FD = 1024` at `src/engine.ts:66`. The
> guard condition at `src/engine.ts:95`:
> `!Number.isInteger(fd) || fd < 3 || fd > MAX_FORWARDED_FD`.*

### Requirement: Capabilities JSON cache invalidates on Engine binary change

The CLI SHALL cache the Capabilities JSON in-process, keyed by the Engine
binary path and its `mtimeMs`. The cache invalidates automatically when the
binary is replaced (e.g. after `kesha install`), ensuring the CLI never uses
stale feature flags after an upgrade.

#### Scenario: Cache hit — no extra subprocess spawned

- GIVEN `getEngineCapabilities()` was called once successfully
- WHEN the CLI calls `getEngineCapabilities()` again with the same binary and
  same `mtimeMs`
- THEN no new subprocess is spawned
- AND the cached result is returned immediately

#### Scenario: Cache miss after install overwrites the binary

- GIVEN `getEngineCapabilities()` was called before `kesha install` ran
- WHEN `kesha install` overwrites the Engine binary (changing its `mtimeMs`)
- THEN the next call to `getEngineCapabilities()` re-spawns the Engine and
  refreshes the cache

> *Technical Note — Cache logic at `src/engine.ts:356`. Cache key:
> `{ binPath, mtime }`. `statSync(binPath).mtimeMs` at `src/engine.ts:368`;
> `statSync` throwing (missing binary) causes `getEngineCapabilities` to
> return `null`.*

## Open Issues

- Protocol version is hardcoded to `3`; there is no negotiation mechanism if
  the CLI and Engine are on incompatible versions. The CLI currently falls back
  to `null` (capabilities unavailable) rather than erroring on version mismatch.
- `KESHA_DEBUG_FD` NDJSON event schema is not yet stable and is not specified
  here; callers should treat the format as internal.
- `E_ENGINE_SPAWN` is a TS-native code that has no corresponding entry in the
  Engine's `--error-codes-json` output; the drift test exempts TS-only codes
  explicitly.
