## ADDED Requirements

### Requirement: `kesha-engine describe` publishes the protocol schema

Running `kesha-engine describe` SHALL print a single JSON object to stdout and exit 0, and that object SHALL be the only place the CLI learns what the Engine accepts. It SHALL carry `protocolVersion` (the integer 4), `backend`, `profile`, `commands` (each subcommand with each accepted flag and the feature that gates it), `features`, `errors` (every Error code with title, category, retryability and origin) and, on builds that synthesize speech, `tts.languages`.

The CLI SHALL validate any argv against `commands` before spawning the Engine: a flag the schema does not list for that subcommand, a flag whose gate is absent from `features`, or a flag whose `requires` is missing or whose `conflicts` is present SHALL be rejected on the CLI side with `E_INVALID_ARG` and no subprocess.

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

> *Technical Note — Subcommand `Describe` in `rust/src/main.rs` (to be added beside `Commands`); schema assembly in `rust/src/protocol/describe.rs`; the gate table and the clap-parity test live there. CLI validation in `src/engine/describe.ts`. Baseline flags today: `rust/src/main.rs:12-20`.*

### Requirement: The protocol version is a gate, not a label

The CLI SHALL refuse to use an Engine whose `describe` reports a `protocolVersion` other than 4, and SHALL report the refusal as the Error code `E_ENGINE_PROTOCOL` with a hint naming the remedy.

#### Scenario: The installed Engine speaks the current protocol

- GIVEN the installed Engine's `describe` reports `protocolVersion: 4`
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

The Engine SHALL write every non-payload line to stderr as one JSON object per line with a `kind` of `progress`, `warn`, `error` or `debug` and a `message`; `error` and `warn` SHALL carry a `code` that is a published Error code; `error` MAY carry a `hint`. stdout SHALL carry only the command's payload. A fatal `error` SHALL be followed by exit code 1, except where the tts-synthesis spec assigns another Exit code.

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

#### Scenario: A line that is not JSON

- GIVEN the Engine crashes and the runtime prints a panic message to stderr
- WHEN the CLI parses stderr
- THEN the failure is reported as `E_INTERNAL` with the raw line in the message

> *Technical Note — Emitter in `rust/src/protocol/events.rs` replacing the 84 `eprintln!` calls across 21 files (`grep -rc 'eprintln!' rust/src`); parser in `src/engine/events.ts` replacing `partitionProgress` at `src/engine.ts:137-163` and `isProgressLine` at `src/engine.ts:131-133` and the regex at `src/error-codes.ts:9`.*

## MODIFIED Requirements

### Requirement: The CLI validates flags against Capabilities JSON instead of forwarding blindly

Before spawning the Engine the CLI SHALL validate the full argv against the `commands` section of the `describe` document, with one generic check rather than a per-feature guard, and SHALL NOT forward any flag the schema does not list for that subcommand.

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

The CLI SHALL report failures that happen before or around the Engine with the same Error code vocabulary the Engine publishes in `describe`: `E_INPUT_NOT_FOUND`, `E_ENGINE_SPAWN`, `E_INVALID_ARG`, `E_ENGINE_PROTOCOL` and `E_INTERNAL` SHALL appear in `errors` with origin `cli`, and every failure the Core API throws SHALL be a `KeshaError` carrying `code` and, when known, `hint`.

#### Scenario: Engine binary missing surfaces E_ENGINE_SPAWN

- GIVEN the Engine binary is absent
- WHEN Sona calls `await say({ text: "hello" })`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_ENGINE_SPAWN` and whose `hint` names `kesha install`

#### Scenario: The generated error reference matches the taxonomy

- GIVEN `docs/errors.md` is generated from `kesha-engine describe`
- WHEN a code is added to the Engine taxonomy without regenerating the document
- THEN the docs check in CI fails naming the missing code

> *Technical Note — Replaces `TS_NATIVE_CODES` and `KNOWN_TS_CODES` at `src/error-codes.ts:18-39` and the drift test in `src/__tests__/error-codes.test.ts`; `KeshaError` in `src/engine/events.ts`; the generator replaces `rust/tests/error_codes_docs.rs`.*

### Requirement: `KESHA_*` environment variables configure both CLI and Engine

Both the CLI and the Engine SHALL honour the `KESHA_*` environment variables listed below; the CLI SHALL read them at startup and the Engine at spawn time, inheriting `process.env` from the CLI. `KESHA_DEBUG_FD` SHALL no longer exist: with `KESHA_DEBUG` set, the Engine's debug timeline SHALL be emitted as `debug` events on the stderr event stream and the CLI SHALL route them to the Diagnostic log.

> *Technical Note — `KESHA_*` env var table:*
>
> | Variable | Read by | Effect |
> |---|---|---|
> | `KESHA_ENGINE_BIN` | CLI | Override Engine binary path (`src/engine.ts:82`). |
> | `KESHA_CACHE_DIR` | CLI + Engine | Override Model cache root (default `~/.cache/kesha/`). CLI: `src/paths.ts:5`. Engine: `rust/src/models/paths.rs::cache_dir`. |
> | `KESHA_MODEL_MIRROR` | Engine | Rewrite HuggingFace download base URLs; GitHub release URLs are never rewritten. Safe because of Pinned hashes (`rust/src/models/download.rs::model_mirror`). |
> | `KESHA_DEBUG` | CLI + Engine | Enable debug trace output. Falsey values: `""`, `"0"`, `"false"`, `"no"`, `"off"` (case-insensitive). Truthy: any other non-empty value. CLI: `src/log.ts:30`. Engine: `rust/src/debug.rs:57`; events emitted through `rust/src/protocol/events.rs`. |
> | `KESHA_DIARIZE_TIMEOUT_SECS` | Engine | Cap total diarization wall time (seconds). Unset or empty means no overall cap; any other non-positive or unparseable value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` | Engine | Replace the 300 s budget for the CoreML model load (seconds). Unset or empty keeps the default; any other non-positive or unparseable value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_COMPUTE_UNITS` | Engine | CoreML compute units for the Sortformer model: `all` (default), `cpu-and-ane`, `cpu-and-gpu`, `cpu-only`. An unrecognised value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_MODEL_PATH` | CLI + Engine | Override the Sortformer model path. CLI: `src/engine.ts:212`. Engine: `rust/src/transcribe/mod.rs:995`. |
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

> *Technical Note — `spawnStdioWithDebugFd` and `MAX_FORWARDED_FD` at `src/engine.ts:103-115` are deleted; `rust/src/debug.rs:159` stops opening a descriptor; `rust/tests/debug_ndjson_fd.rs` becomes a test of `debug` events on stderr.*

### Requirement: Capabilities JSON cache invalidates on Engine binary change

The CLI SHALL cache the `describe` document in-process, keyed by the Engine binary path and its `mtimeMs`, and SHALL invalidate it when the binary is replaced, so an upgrade never runs against a stale schema.

#### Scenario: Cache hit — no extra subprocess spawned

- GIVEN the schema was read once successfully
- WHEN the CLI needs it again for the same binary and the same `mtimeMs`
- THEN no new subprocess is spawned

#### Scenario: Cache miss after install overwrites the binary

- GIVEN the schema was read before `kesha install` ran
- WHEN `kesha install` overwrites the Engine binary
- THEN the next read re-spawns `kesha-engine describe` and refreshes the cache

> *Technical Note — Today at `src/engine.ts:633-700` (`getEngineCapabilities`); moves to `src/engine/describe.ts` with the same key.*

## REMOVED Requirements

### Requirement: `--capabilities-json` describes the Engine's feature set

**Reason**: replaced by `kesha-engine describe`, which carries the same fields plus the per-command flag schema. **Migration**: the capability-pact recorder (`.github/scripts/record-capability-pacts.ts:117`), its fixtures under `tests/fixtures/capabilities/`, the release install smoke (`.github/scripts/release-install-smoke.sh:52`) and `docs/nix-install.md:15` call `describe` instead.

### Requirement: `--error-codes-json` prints the full error-code taxonomy

**Reason**: folded into the `errors` section of `describe`. **Migration**: `rust/tests/error_codes_cli.rs` and the `docs/errors.md` generator read `describe`.

### Requirement: Engine stderr format is `error [E_CODE]: <message>`

**Reason**: replaced by the event stream. **Migration**: the regex at `src/error-codes.ts:9` and every Rust test asserting `error [` are rewritten against `kind`/`code`.
