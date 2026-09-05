## ADDED Requirements

### Requirement: `kesha-engine describe` publishes the protocol schema

Running `kesha-engine describe` SHALL print a single JSON object to stdout and exit 0, and that describe document SHALL be the only place the CLI learns what the Engine accepts. It SHALL carry `protocolVersion` (the integer 4), `backend`, `profile`, `commands` (each subcommand with each accepted flag and the feature that gates it), `features`, `errors` (every Error code with title, category, retryability and origin), `warnings` (every Warning code with title) and, on builds that synthesize speech, `tts.languages`.

The `errors` section SHALL mark exactly `E_MODEL_DOWNLOAD`, `E_DIARIZE_TIMEOUT` and `E_INSTALL_RACE` as retryable.

The CLI SHALL validate any argv against `commands` before spawning the Engine: a flag the schema does not list for that subcommand, a flag whose gate is absent from `features`, or a flag whose `requires` is missing or whose `conflicts` is present SHALL be rejected on the CLI side with `E_INVALID_ARG` and no subprocess. A flag whose schema row carries `whenUngated: drop` SHALL instead be omitted from the argv with one `warn` event when its gate is absent from `features`, and the command SHALL proceed; the default is `reject`. A `gate` names one feature or an any-of list of features.

A platform pre-check that runs before anything is downloaded SHALL report `E_UNSUPPORTED_PLATFORM`, because no Engine is needed to know the platform; once an Engine binary exists, `kesha install` SHALL validate its argv against the describe document before spawning `kesha-engine install`, so a flag whose gate the build does not carry is `E_INVALID_ARG`.

#### Scenario: Sona probes the Engine before calling `say`

- GIVEN the Engine is a build that synthesizes speech
- WHEN the CLI runs `kesha-engine describe`
- THEN the result has `protocolVersion: 4` and `features` contains `"tts"`
- AND `tts.languages` contains at least `{ code: "en", engines: ["kokoro"] }` and `{ code: "ru", engines: ["vosk"] }`

#### Scenario: A flag the Engine does not accept never reaches it

- GIVEN the Engine's schema lists `--speakers` under `transcribe` gated on `transcribe.diarize`
- AND `features` does not contain `transcribe.diarize`
- WHEN Ira runs `kesha meeting.ogg --speakers`
- THEN the CLI exits with `E_INVALID_ARG` naming darwin-arm64 as the platform that serves it
- AND no Engine subprocess is spawned

#### Scenario: Install pre-check runs before any Engine exists

- GIVEN no Engine is installed on a linux-x64 host
- WHEN Sona calls `install({ diarize: true })`
- THEN the CLI rejects with `E_UNSUPPORTED_PLATFORM` before downloading anything
- AND on a darwin-arm64 host whose installed Engine is a `portable` build, `install --diarize` is `E_INVALID_ARG` from the schema because `transcribe.diarize` is absent from `features`

#### Scenario: An optional flag on an Engine without its feature

- GIVEN the Engine advertises neither `tts.ru_acronym_expansion` nor `tts.en_acronym_expansion`
- WHEN Sona calls `say({ text: "NASA", noExpandAbbrev: true })`
- THEN the CLI omits `--no-expand-abbrev` from the argv and renders one `warn` event naming the flag
- AND synthesis proceeds and resolves with audio

> *Technical Note — Subcommand `Describe` in `rust/src/main.rs` (to be added beside `Commands`); schema assembly in `rust/src/protocol/describe.rs`; the gate table and the clap-parity test live there. CLI validation in `src/engine/describe.ts`. Baseline flags today: `rust/src/main.rs:12-18`. The platform pre-check throws a bare `Error` at `src/cli/install.ts:228-233` today; v4 assigns it `E_UNSUPPORTED_PLATFORM`. The `whenUngated: drop` row for `--no-expand-abbrev` replaces `applyNoExpandAbbrev` (`src/synth.ts:69-85`).*
>
> *Error code taxonomy carried in `errors` (today `rust/src/errors.rs:36-56` for the codes, `:69-119` for title/category/retryable):*
>
> | Code | Category | Retryable | Origin | Title |
> |---|---|---|---|---|
> | `E_INPUT_NOT_FOUND` | input | no | both | Input file not found |
> | `E_BAD_AUDIO` | input | no | engine | Unreadable or unsupported audio |
> | `E_INVALID_ARG` | input | no | both | Invalid command-line argument |
> | `E_MODEL_MISSING` | model | no | engine | Model or voice not installed |
> | `E_MODEL_DOWNLOAD` | model | **yes** | engine | Model download failed |
> | `E_CACHE_CORRUPT` | model | no | engine | Cached model failed verification |
> | `E_MODEL_LOAD` | model | no | engine | Model failed to load |
> | `E_UNSUPPORTED_PLATFORM` | platform | no | engine | Feature unsupported on this platform |
> | `E_SIDECAR_MISSING` | platform | no | engine | Helper sidecar missing or failed |
> | `E_NO_BACKEND` | platform | no | engine | No ASR backend compiled in |
> | `E_ENGINE_SPAWN` | platform | no | cli | Engine binary missing or failed to start |
> | `E_ENGINE_PROTOCOL` | platform | no | cli | Engine speaks a protocol the CLI does not |
> | `E_TEXT_EMPTY` | tts | no | engine | Empty synthesis text |
> | `E_TEXT_TOO_LONG` | tts | no | engine | Synthesis text too long |
> | `E_VOICE_UNKNOWN` | tts | no | engine | Unknown voice id |
> | `E_SSML_INVALID` | tts | no | engine | Malformed SSML |
> | `E_SSML_UNSUPPORTED` | tts | no | engine | SSML not supported for this engine |
> | `E_SCRIPT_UNSUPPORTED` | tts | no | engine | Text script not supported for this voice |
> | `E_TRANSCRIBE_FAILED` | transcribe | no | engine | Transcription failed |
> | `E_DIARIZE_TIMEOUT` | transcribe | **yes** | engine | Speaker diarization timed out |
> | `E_INSTALL_RACE` | internal | **yes** | cli | Another install reached the same cache first |
> | `E_INTERNAL` | internal | no | both | Unexpected internal error |
>
> *Feature strings and their gates (today `rust/src/capabilities.rs:34-75`; the gates become Profile names once `build-profiles` lands):*
>
> | Feature | Gate |
> |---|---|
> | `"transcribe"` | always |
> | `"transcribe.segments"` | always |
> | `"transcribe.itn"` | always |
> | `"transcribe.words"` | any ASR Backend |
> | `"detect-lang"` | always |
> | `"vad"` | always |
> | `"detect-text-lang"` | `target_os = "macos"` |
> | `"tts"` | `feature = "tts"` |
> | `"tts.ru_acronym_expansion"` | `feature = "tts"` |
> | `"tts.en_acronym_expansion"` | `feature = "tts"` |
> | `"tts.ru_emphasis_marker"` | `feature = "tts"` |
> | `"tts.prosody_rate"` | `feature = "tts"` |
> | `"record.live"` | `darwin` Profile |
> | `"record.live.auto-stop"` | `darwin` Profile |
> | `"transcribe.diarize"` | `darwin` Profile |

### Requirement: The protocol version is a gate, not a label

The CLI SHALL refuse to use an Engine whose describe document reports a `protocolVersion` other than 4, and SHALL report the refusal as the Error code `E_ENGINE_PROTOCOL` with a hint naming the remedy.

#### Scenario: The installed Engine speaks the current protocol

- GIVEN the installed Engine's describe document reports `protocolVersion: 4`
- WHEN Ira runs `kesha note.ogg`
- THEN the CLI validates the argv against the schema and spawns the transcription
- AND no `E_ENGINE_PROTOCOL` is reported

#### Scenario: A stale Engine after a CLI upgrade

- GIVEN Maks upgraded the CLI but the cached Engine still answers protocol 3
- WHEN he runs `kesha note.ogg`
- THEN the CLI exits 1 with `E_ENGINE_PROTOCOL`
- AND the hint names `kesha install`

#### Scenario: A newer Engine installed for one invocation

- GIVEN Ira ran `kesha install --engine-version` with a release whose protocol is 5
- WHEN she runs `kesha note.ogg`
- THEN the CLI exits 1 with `E_ENGINE_PROTOCOL`
- AND the hint names the CLI upgrade command with `bun add -g`

> *Technical Note — Today `parseCapabilities` at `src/engine.ts:680-687` accepts any numeric `protocolVersion`; `tests/helpers/fake-engine.ts:99` answers `2` and passes. The gate lives in `src/engine/describe.ts`.*

### Requirement: Engine stderr is an event stream

The Engine SHALL write every non-payload line to stderr as one JSON object per line with a `kind` of `progress`, `warn`, `error` or `debug` and a `message`; `error` and `warn` SHALL each carry a `code` that is a published Error code (`error`) or a published Warning code from `warnings` (`warn`); `error` MAY carry a `hint`. stdout SHALL carry only the command's payload. A fatal `error` SHALL be followed by exit code 1, except where the tts-synthesis spec assigns another Exit code.

Argument-parsing failures SHALL join the Event stream rather than bypass it: a clap parse error and a missing subcommand SHALL each be emitted as one `error` event whose `code` is `E_INVALID_ARG` and whose `message` carries clap's own text including the usage line, and the process SHALL exit 2. `--help` and `--version` SHALL remain plain prose on stdout and are the only prose exemption.

The CLI SHALL render events for humans and SHALL treat a stderr line that is not a JSON object as `E_INTERNAL`, quoting the line. The CLI SHALL accept `\r\n` line endings.

#### Scenario: Missing model produces a parseable Error code

- GIVEN the ASR model is not installed
- WHEN Ira runs `kesha standup.ogg`
- THEN Engine stderr contains a line whose `kind` is `error` and whose `code` is `E_MODEL_MISSING`
- AND the CLI prints the message and the hint and exits 1

#### Scenario: Progress reaches the caller while the run is in flight

- GIVEN a diarization run whose model load takes a minute
- WHEN the Engine emits `progress` events during the load
- THEN Sona's `onProgress` callback receives each one before the run completes

#### Scenario: No subcommand

- WHEN Ira runs `kesha-engine` with no arguments
- THEN stderr carries one `error` event with code `E_INVALID_ARG` whose message contains `Usage: kesha-engine`
- AND the process exits 2

#### Scenario: A line that is not JSON

- GIVEN the Engine crashes and the runtime prints a panic message to stderr
- WHEN the CLI parses stderr
- THEN the failure is reported as `E_INTERNAL` with the raw line in the message

> *Technical Note — Emitter in `rust/src/protocol/events.rs` replacing the 84 `eprintln!` calls across 21 files (`grep -rc 'eprintln!' rust/src`); parser in `src/engine/events.ts` replacing `partitionProgress` at `src/engine.ts:137-163` and `isProgressLine` at `src/engine.ts:131-133` and the regex at `src/error-codes.ts:9`. `Cli::parse()` at `rust/src/main.rs:99` becomes `try_parse`, and the usage-and-exit-1 arm at `rust/src/main.rs:155-157` becomes the `E_INVALID_ARG` event with exit 2.*

## MODIFIED Requirements

### Requirement: The CLI validates flags against Capabilities JSON instead of forwarding blindly

Before spawning the Engine the CLI SHALL validate the full argv against the `commands` section of the describe document, with one generic check rather than a per-feature guard, and SHALL NOT forward any flag the schema does not list for that subcommand.

#### Scenario: A valid argv reaches the Engine unchanged

- GIVEN the Engine's schema lists `--json` and `--itn` under `transcribe` with no absent gate
- WHEN Ira runs `kesha meeting.ogg --json --itn`
- THEN the CLI passes both flags through to the Engine subprocess unchanged
- AND no validation error is reported

#### Scenario: Diarization requested on a non-diarize build

- GIVEN the Engine's `features` does not contain `transcribe.diarize`
- WHEN Sona calls `transcribe("meeting.ogg", { speakers: true })`
- THEN the call rejects with a `KeshaError` whose `code` is `E_INVALID_ARG` and whose message states diarization is darwin-arm64 only
- AND no Engine subprocess is spawned

#### Scenario: Unknown flag not forwarded to install

- GIVEN the CLI's install command is invoked with `--format json`
- WHEN the CLI constructs the Engine argv for `kesha-engine install`
- THEN `--format` is absent from the argv because the schema does not list it under `install`
- AND the CLI does not need a hand-written list of install flags to know that

> *Technical Note — Replaces `preflightTranscribeEngineItn`, `preflightTranscribeEngineWithSegments`, `assertSpeakersSupported` and `assertItnSupported` (`src/engine.ts:326-380`) and `buildEngineInstallArgs` (`src/engine-install.ts`) with `validateArgv(command, flags, schema)` in `src/engine/describe.ts`. The CLAUDE.md rule "DO NOT BLINDLY FORWARD CLI FLAGS TO SUBCOMMANDS" is deleted once this lands, because the schema enforces it.*

### Requirement: TS-native codes cover CLI-side failures

The CLI SHALL report failures that happen before or around the Engine with the same Error code vocabulary the Engine publishes in its describe document: `E_INPUT_NOT_FOUND`, `E_ENGINE_SPAWN`, `E_INVALID_ARG`, `E_ENGINE_PROTOCOL`, `E_INSTALL_RACE` and `E_INTERNAL` SHALL appear in `errors`, and every failure the Core API throws SHALL be a `KeshaError` carrying `code`, `hint` when known, and `exitCode` and `stderr` whenever an Engine subprocess ran.

Each entry's `origin` SHALL be `engine`, `cli` or `both`: `E_INPUT_NOT_FOUND`, `E_INVALID_ARG` and `E_INTERNAL` are `both` because either side raises them, while `E_ENGINE_SPAWN`, `E_ENGINE_PROTOCOL` and `E_INSTALL_RACE` are `cli` because only the CLI can observe them.

These codes SHALL appear in structured error records (`TranscribeErrorRecord.code`).

#### Scenario: A successful call reports no code

- GIVEN the Engine and the English TTS models are installed
- WHEN Sona calls `await say({ text: "hello" })`
- THEN the promise resolves with the audio bytes
- AND no `error` event and no `KeshaError` is produced

#### Scenario: Engine binary missing surfaces E_ENGINE_SPAWN

- GIVEN the Engine binary is absent
- WHEN Sona calls `await say({ text: "hello" })`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_ENGINE_SPAWN` and whose `hint` names `kesha install`

#### Scenario: The generated error reference matches the taxonomy

- GIVEN `docs/errors.md` is generated from `kesha-engine describe`
- WHEN a code is added to the Engine taxonomy without regenerating the document
- THEN the docs check in CI fails naming the missing code

> *Technical Note — Replaces `TS_NATIVE_CODES` and `KNOWN_TS_CODES` at `src/error-codes.ts:18-40` and the drift test in `src/__tests__/error-codes.test.ts`; `KeshaError` in `src/engine/events.ts`; the generator replaces `rust/tests/error_codes_docs.rs`.*

### Requirement: `KESHA_*` environment variables configure both CLI and Engine

Both the CLI and the Engine SHALL honour the `KESHA_*` environment variables listed below; the CLI SHALL read them at startup and the Engine at spawn time, inheriting `process.env` from the CLI. `KESHA_DEBUG_FD` SHALL no longer exist: with `KESHA_DEBUG` set, the Engine's debug timeline SHALL be emitted as `debug` events on the Event stream and the CLI SHALL route them to the Diagnostic log.

> *Technical Note — `KESHA_*` env var table:*
>
> | Variable | Read by | Effect |
> |---|---|---|
> | `KESHA_ENGINE_BIN` | CLI | Override Engine binary path (`src/engine.ts:82`). |
> | `KESHA_CACHE_DIR` | CLI + Engine | Override Model cache root (default `~/.cache/kesha/`). CLI: `src/paths.ts:5`. Engine: `rust/src/models/paths.rs::cache_dir`. |
> | `KESHA_MODEL_MIRROR` | Engine | Rewrite HuggingFace download base URLs; GitHub release URLs are never rewritten. Safe because of Pinned hashes (`rust/src/models/download.rs::model_mirror`). |
> | `KESHA_DEBUG` | CLI + Engine | Enable debug trace output. Falsey values: `""`, `"0"`, `"false"`, `"no"`, `"off"` (case-insensitive). Truthy: any other non-empty value. CLI: `src/log.ts:30`. Engine: `rust/src/debug.rs:41-58`; events emitted through `rust/src/protocol/events.rs`. |
> | `KESHA_DIARIZE_TIMEOUT_SECS` | Engine | Cap total diarization wall time (seconds). It can only cut a run short — the phase budgets still apply, so it never widens one. Unset or empty means no overall cap; any other non-positive or unparseable value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` | Engine | Replace the 300 s budget for the CoreML model load (seconds). Does not affect the other phases. Unset or empty keeps the default; any other non-positive or unparseable value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_COMPUTE_UNITS` | Engine | CoreML compute units for the Sortformer model: `all` (default), `cpu-and-ane`, `cpu-and-gpu`, `cpu-only`. An unrecognised value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_MODEL_PATH` | CLI + Engine | Override the Sortformer model path. CLI: `src/engine.ts:293`. Engine: `rust/src/transcribe/mod.rs:995`. |
> | `KESHA_STATS_DB` | CLI | Override the Stats DB path (`src/stats.ts:579`). |
> | `KESHA_LOG_DIR` | CLI | Override the Diagnostic log directory (`src/diagnostic-log.ts:73`). |

#### Scenario: Ira points the cache at a network share in CI

- GIVEN `KESHA_CACHE_DIR=/mnt/ci-cache/kesha` is set
- WHEN Ira runs `kesha standup.ogg`
- THEN the CLI resolves the Engine binary from `/mnt/ci-cache/kesha/`
- AND the Engine reads models from `/mnt/ci-cache/kesha/models/`

#### Scenario: Debug timeline with no extra descriptor

- GIVEN `KESHA_DEBUG=1` is set and `KESHA_DEBUG_FD` is also set from an old script
- WHEN Maks runs `kesha note.ogg`
- THEN `KESHA_DEBUG_FD` is ignored
- AND the Engine's `debug` events appear in the Diagnostic log for that run

> *Technical Note — `spawnStdioWithDebugFd` and `MAX_FORWARDED_FD` at `src/engine.ts:94-115` are deleted; `rust/src/debug.rs:113-123` stops opening a descriptor; `rust/tests/debug_ndjson_fd.rs` becomes a test of `debug` events on stderr.*

### Requirement: Capabilities JSON cache invalidates on Engine binary change

The CLI SHALL cache the describe document in-process, keyed by the Engine binary path and its `mtimeMs`, and SHALL invalidate it when the binary is replaced, so an upgrade never runs against a stale schema.

#### Scenario: Cache hit — no extra subprocess spawned

- GIVEN the schema was read once successfully
- WHEN the CLI needs it again for the same binary and the same `mtimeMs`
- THEN no new subprocess is spawned

#### Scenario: Cache miss after install overwrites the binary

- GIVEN the schema was read before `kesha install` ran
- WHEN `kesha install` overwrites the Engine binary
- THEN the next read re-spawns `kesha-engine describe` and refreshes the cache

> *Technical Note — Today at `src/engine.ts:633-697` (`getEngineCapabilities`); moves to `src/engine/describe.ts` with the same key.*

### Requirement: The written-form pass is advertised and validated, never forwarded blind

The describe document SHALL advertise the Engine's support for the written-form Transcription pass in `features`, and the CLI SHALL validate the request against that document before spawning the Engine.

An Engine that does not advertise it SHALL cause the request to fail with the action that resolves it, on every Transcription path — not only the timestamped one — as a `KeshaError` whose `code` is `E_INVALID_ARG`.

#### Scenario: Sona inspects a current Engine

- GIVEN an Engine built from this change
- WHEN Sona reads its describe document
- THEN `features` contains the written-form pass entry
- AND it is present regardless of which Backend the Engine was compiled with

#### Scenario: Ira runs a new CLI against an Engine installed months ago

- GIVEN an installed Engine whose describe document omits the entry
- WHEN Ira transcribes with the written-form pass requested
- THEN the command fails before the Engine is spawned
- AND the message names upgrading the Engine as the action

#### Scenario: the stale Engine is used without the pass

- GIVEN the same installed Engine
- WHEN Ira transcribes without requesting the pass
- THEN Transcription succeeds as before

> *Technical Note — feature string `transcribe.itn`, declared once as `TRANSCRIBE_ITN_FEATURE` (`rust/src/transcribe/mod.rs:36`) and pushed unconditionally today at `rust/src/capabilities.rs:36-41`; it becomes a gate row in `rust/src/protocol/describe.rs`. Unlike `transcribe.diarize` this is not Backend-gated: the pass is pure Rust and behaves identically on CoreML and ONNX, so the gate exists for Engine-version skew only. The hand-written mirror `TRANSCRIBE_ITN_FEATURE` at `src/engine.ts:34` and the hoisted check at `src/transcribe.ts:57` are both replaced by the generic `validateArgv` in `src/engine/describe.ts`, which keeps the check above the `timestamps || speakers` short-circuit because the pass is meaningful with plain text output.*

### Requirement: `record.live` is advertised only by Engines that can serve it

The Engine SHALL include `record.live` in the `features` array of its describe document when, and only when, it was compiled with the CoreML Backend on macOS. On every other build the flag SHALL be absent from the array rather than present-and-false, matching how the feature vector already treats `transcribe.diarize` and `detect-text-lang`.

#### Scenario: Maks probes a CoreML Engine on Apple Silicon

- WHEN Maks runs `kesha-engine describe`
- THEN `features` contains `"record.live"` alongside `"transcribe"`
- AND `backend` is `"coreml"`

#### Scenario: Ira probes the Linux ONNX Engine

- WHEN Ira runs `kesha-engine describe` on the Linux build
- THEN `features` does not contain `"record.live"`
- AND the rest of the document is unchanged in shape

> *Technical Note — the push is gated on `#[cfg(all(feature = "coreml", target_os = "macos"))]` at `rust/src/capabilities.rs:49-53`, mirroring the runtime gate exactly so the advertisement cannot outlive the code path; the gate moves to the table in `rust/src/protocol/describe.rs`. `protocolVersion` is 4: adding a feature string is additive and the generic flag-validation contract covers it.*

### Requirement: Engine spawn failures surface as E_ENGINE_SPAWN

Any failure to launch the `kesha-engine` binary (missing file, permission denied) SHALL surface as a `KeshaError` whose `code` is `E_ENGINE_SPAWN`, carrying the attempted binary path, the underlying cause, and a `hint` naming the remedy (`kesha install`, or `KESHA_ENGINE_BIN` when it is set). Raw `posix_spawn`/ENOENT exceptions MUST NOT reach Ira, Maks or Sona.

#### Scenario: the engine binary runs

- GIVEN the Engine binary exists at the resolved path and the OS executes it
- WHEN Ira runs `kesha standup.ogg`
- THEN the subprocess starts and no `E_ENGINE_SPAWN` is reported

#### Scenario: engine binary path does not exist

- WHEN any CLI or MCP code path spawns the Engine and the binary path does not exist
- THEN the surfaced `KeshaError` carries `code` `E_ENGINE_SPAWN`, names the path, and carries an actionable `hint`

> *Technical Note — `KeshaError` in `src/engine/events.ts` replaces the `SayError` construction at `src/synth.ts:172-178` and the ad-hoc rethrow at `src/engine.ts:183-186`.*

## REMOVED Requirements

### Requirement: `--capabilities-json` describes the Engine's feature set

**Reason**: replaced by `kesha-engine describe`, which carries the same fields plus the per-command flag schema. **Migration**: the capability-pact recorder (`.github/scripts/record-capability-pacts.ts:117`), its fixtures under `tests/fixtures/capabilities/`, the release install smoke (`.github/scripts/release-install-smoke.sh:52`) and `docs/nix-install.md:15` call `describe` instead.

### Requirement: `--error-codes-json` prints the full error-code taxonomy

**Reason**: folded into the `errors` section of the describe document. **Migration**: `rust/tests/error_codes_cli.rs` and the `docs/errors.md` generator read `describe`.

### Requirement: Engine stderr format is `error [E_CODE]: <message>`

**Reason**: replaced by the Event stream. **Migration**: the regex at `src/error-codes.ts:9` and every Rust test asserting `error [` are rewritten against `kind`/`code`.
