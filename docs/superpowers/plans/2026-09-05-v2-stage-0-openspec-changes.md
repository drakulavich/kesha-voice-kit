# v2 Stage 0: OpenSpec Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four OpenSpec changes that define the v2 contracts (`protocol-v4`, `build-profiles`, `core-api-v2`, `unified-release`), each valid under `openspec validate --strict`, so stages 1–5 implement against written, reviewed contracts.

**Architecture:** Each change is a directory under `openspec/changes/<name>/` with `.openspec.yaml`, `proposal.md`, `design.md`, `tasks.md` and one delta spec per touched capability under `specs/<capability>/spec.md`. Delta specs use `## ADDED Requirements`, `## MODIFIED Requirements` and `## REMOVED Requirements` sections; a MODIFIED requirement repeats the baseline title verbatim and replaces its whole body. No code changes in this plan.

**Tech Stack:** OpenSpec 1.4.1 (`openspec` on PATH at `~/.bun/bin/openspec`; CI runs `bunx @fission-ai/openspec@1.4.1`), Bun, git worktree `.worktrees/refactor-v2-design` on branch `refactor-v2-design` (PR #1153).

**Spec:** `docs/superpowers/specs/2026-09-05-v2-contract-first-refactor-design.md`

## Global Constraints

- Work only inside `.worktrees/refactor-v2-design`; the root checkout stays on `main`. Every shell command in this plan starts with `cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design`.
- Repository artefacts are English only; scan added lines for Cyrillic before committing.
- OpenSpec rules from `openspec/config.yaml`: `SHALL` or `MUST` on the FIRST line of every requirement body; glossary terms from `openspec/specs/GLOSSARY.md` verbatim (Engine, CLI, Backend, Capabilities JSON, Error code, Exit code, Pinned Engine version, Channel, Alpha, Prerelease, Core API, Distribution path, Model cache); every requirement has at least one happy-path and one error/edge scenario; requirement text states outcomes, not mechanisms; personas are Ira (CI engineer), Maks (macOS power user), Sona (agent author), never "user"; anything uncertain goes under "Open Issues"; each requirement traces to code with a `file:line` Technical Note; every proposal has a "Non-goals" section.
- The validator is the test. Red is `openspec validate <name> --type change --strict --no-interactive` failing; green is `Change '<name>' is valid`. `bun run check:specs` (baseline specs) must stay green after every task.
- Commit messages end with the two trailers used on this branch:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_013RKSL2xGHE1y3njSG8oymq`.
- Do not create tests, code, or CI changes here. Pact tests drafted for v4 land with the first stage-1 PR (spec section 4).

---

### Task 1: `protocol-v4` change (contract C1)

**Files:**
- Create: `openspec/changes/protocol-v4/.openspec.yaml` (by `openspec new change`)
- Create: `openspec/changes/protocol-v4/proposal.md`
- Create: `openspec/changes/protocol-v4/design.md`
- Create: `openspec/changes/protocol-v4/specs/engine-contract/spec.md`
- Create: `openspec/changes/protocol-v4/tasks.md`

**Interfaces:**
- Consumes: baseline `openspec/specs/engine-contract/spec.md` requirement titles (lines 48, 105, 138, 192, 225, 251, 297).
- Produces: the names later changes cite — subcommand `kesha-engine describe`, stderr event kinds `progress | warn | error | debug`, `KeshaError { code, hint }`, `protocolVersion: 4`.

- [ ] **Step 1: Scaffold the change and confirm the validator is red**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec new change "protocol-v4"
cat openspec/changes/protocol-v4/.openspec.yaml
openspec validate protocol-v4 --type change --strict --no-interactive; echo "exit=$?"
```

Expected: `.openspec.yaml` contains `schema: spec-driven` and a `created:` date; validate exits non-zero because no proposal or delta spec exists yet.

- [ ] **Step 2: Write `proposal.md`**

```markdown
# Proposal: protocol-v4

## Why

The CLI and the Engine talk through four ad-hoc conventions: a regex over stderr for the Error code, a string prefix (`diarize: `) for progress, a separately forwarded file descriptor for the debug timeline, and two flags (`--capabilities-json`, `--error-codes-json`) that the CLI must hand-mirror in `preflight*` functions and a TS-side code registry with a drift test. The CLI parses `protocolVersion` but never gates on it — a stub answering `2` passes today. Each new Engine flag touches nine runtime files because nothing declares which flags a subcommand accepts (design spec section 5).

## What Changes

- **stdout carries payload only**; everything else the Engine says goes to stderr as NDJSON, one object per line with a `kind` of `progress`, `warn`, `error` or `debug`. The CLI renders these for humans; the Engine never prints prose.
- **`kesha-engine describe`** replaces `--capabilities-json` and `--error-codes-json` with one document: `protocolVersion: 4`, `backend`, `profile`, every subcommand with its flags and gates, the Error code taxonomy, TTS languages.
- **The protocol version becomes a gate**: a `describe` reporting any version other than 4 is an actionable Error code, not a silent success.
- **One error class on the CLI side**, `KeshaError { code, hint }`, for Engine-reported and CLI-native failures; the CLI-native codes join the taxonomy `describe` publishes and the drift test disappears.
- **`KESHA_DEBUG_FD` is removed**; the debug timeline rides the same stream as `kind: "debug"`.
- **`say --stdin-loop`** keeps its stdin framing; its status lines move to the event stream.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `engine-contract`: Capabilities JSON and the error-code flag are replaced by `describe`; stderr becomes an event stream; the version is gated; TS-native codes fold into the published taxonomy; `KESHA_DEBUG_FD` is removed; the cache requirement keys on the `describe` document.

## Impact

- Engine: `rust/src/main.rs`, `rust/src/capabilities.rs`, `rust/src/errors.rs`, `rust/src/debug.rs`, every `eprintln!` site (84 calls in 21 files), `rust/src/say_loop.rs`.
- CLI: `src/engine.ts`, `src/synth.ts`, `src/transcribe.ts`, `src/error-codes.ts`, `src/doctor.ts`, `src/cli/main.ts`.
- Direct protocol consumers that migrate with the Engine: `.github/scripts/record-capability-pacts.ts` and `tests/fixtures/capabilities/*.json`, `.github/scripts/release-install-smoke.sh`, `rust/tests/error_codes_cli.rs`, `rust/tests/diarize_e2e.rs`, `rust/tests/kokoro_rate_e2e.rs`, `rust/tests/tts_smoke.rs`, `rust/tests/debug_ndjson_fd.rs`, `docs/errors.md`.
- Not affected: `kesha status --json` (a CLI contract Raycast reads; unchanged shape), OpenClaw and Hermes (CLI only).

## Non-goals

- Changing the audio bytes `say` writes to stdout, the `TranscribeResult` JSON shape, or any `kesha` (CLI) flag.
- A "human" output mode for `kesha-engine` run by hand; `kesha` is the human interface.
- Streaming transcripts or any new Engine feature; this is a transport change only.
```

- [ ] **Step 3: Write `design.md`**

```markdown
## Context

Today's boundary (baseline `engine-contract`): `--capabilities-json` (protocol 3), `--error-codes-json`, `error [E_CODE]: <message>` on stderr, `diarize: ` progress prefix detected at `src/engine.ts:140`, `KESHA_DEBUG_FD` forwarded at `src/engine.ts:103-115`. The CLI mirrors Engine gates by hand in `preflightTranscribeEngineItn`, `preflightTranscribeEngineWithSegments`, `assertSpeakersSupported` (`src/engine.ts:326-380`) and keeps `TS_NATIVE_CODES` with a drift test (`src/error-codes.ts`).

## Goals / Non-Goals

Goals: one machine-readable side channel; one schema the CLI validates against generically; a version gate; one error type on the CLI side. Non-goals: as in the proposal.

## Decisions

### D1. Event stream on stderr, payload on stdout

Every non-payload line the Engine emits is one JSON object on stderr:

```json
{"kind":"progress","phase":"diarize","message":"loading model","pct":12}
{"kind":"warn","code":"W_VAD_NOT_INSTALLED","message":"audio is 400s; kesha install --vad would improve accuracy"}
{"kind":"error","code":"E_MODEL_MISSING","message":"voice 'ru-vosk-m02' not installed","hint":"kesha install --tts ru"}
{"kind":"debug","t_ms":412,"event":"asr.decode.start"}
```

`kind` and `message` are required; `code` is required on `error` and `warn`; `hint` is optional and is what the CLI prints after the message. A fatal `error` is followed by exit code 1 (the `say` exit-code exceptions in the tts-synthesis spec stay). Lines are `\n`-terminated; the CLI parser strips a trailing `\r` so Windows output parses identically. A line that is not valid JSON is a protocol violation the CLI reports as `E_INTERNAL` with the raw line in the message.

Why stderr and not a third fd: stderr is what every runner, CI log and `2>` redirection already captures; the fd forwarding existed only to keep debug lines out of prose stderr, and with no prose left there is nothing to keep apart.

### D2. `describe` is the whole schema

`kesha-engine describe` prints one JSON object on stdout and exits 0:

```json
{
  "protocolVersion": 4,
  "backend": "coreml",
  "profile": "darwin",
  "commands": {
    "transcribe": {
      "flags": {
        "json": {"gate": null},
        "vad": {"gate": null, "conflicts": ["no-vad"]},
        "speakers": {"gate": "transcribe.diarize", "requires": ["json"]},
        "itn": {"gate": "transcribe.itn"}
      }
    },
    "install": {"flags": {"no-cache": {"gate": null}, "tts": {"gate": "tts", "values": "langs"}, "vad": {"gate": null}, "diarize": {"gate": "transcribe.diarize"}, "no-warmup": {"gate": null}}},
    "say": {"flags": {"voice": {"gate": "tts"}, "stdin-loop": {"gate": "tts"}}},
    "record": {"flags": {"live": {"gate": "record.live"}, "auto-stop": {"gate": "record.live.auto-stop", "requires": ["live"]}}}
  },
  "features": ["transcribe", "transcribe.segments", "transcribe.itn", "transcribe.diarize", "detect-lang", "vad", "tts", "record.live"],
  "errors": [{"code": "E_MODEL_MISSING", "title": "Model or voice not installed", "category": "model", "retryable": false}],
  "tts": {"languages": [{"code": "en", "engines": ["kokoro"]}]}
}
```

The flag list is derived from clap at runtime (`CommandFactory::command()`); the gates live in a table beside it, and a unit test asserts the two sets are equal, so a flag cannot exist without a schema row. `features` stays for consumers that only need a boolean. The CLI validates any argv with one function: every flag must exist for the command, its gate (if any) must be in `features`, its `requires` must be present and its `conflicts` absent. The CLI-native codes `E_INPUT_NOT_FOUND`, `E_ENGINE_SPAWN`, `E_INVALID_ARG`, `E_INTERNAL` are listed in `errors` with `"origin": "cli"`, so `docs/errors.md` can be generated from `describe` and no TS registry needs a drift test.

### D3. Version gate

The CLI refuses a `describe` whose `protocolVersion` is not 4 with `E_ENGINE_PROTOCOL` and the hint `kesha install` (a too-old Engine) or `bun add -g @drakulavich/kesha-voice-kit@latest` (a too-new Engine). Both directions are gated because both happen: `--engine-version` installs any release for one invocation.

### D4. Migration carrier

The Engine ships v4 as `v1.25.0-beta.1` (draft, un-drafted by hand); the CLI's first stage-2 PR pins that beta. `check:versions` rule 3 accepts a `-beta.N` pin and refuses an alpha, and beta releases are never pruned (design spec section 4).

## Risks / Trade-offs

- Anyone tailing `kesha-engine` stderr by hand sees JSON. Accepted; the CLI is the human interface and `docs/nix-install.md:15` changes its example to `describe`.
- Rust integration tests that assert on stderr prose (`diarize_e2e.rs:249`, `tts_smoke.rs:140`, `kokoro_rate_e2e.rs:78`, `error_codes_cli.rs:10`) rewrite their assertions to `kind`/`code`; that is the stage-1 work, not a hidden cost.

## Migration Plan

Stage 1 (Engine, 4–5 PRs): `describe` + gate table + parity test; event emitter replacing `eprintln!`; delete `--capabilities-json`, `--error-codes-json`, `KESHA_DEBUG_FD`; migrate the pact recorder, release smoke, Rust tests, `docs/errors.md`; tag `v1.25.0-beta.1`. Stage 2 (CLI, 5–6 PRs): beta pin, generic validation, event renderer, `KeshaError`; then one PR per command.

## Open Questions

- Whether `progress` events carry `pct` for every phase or only diarization. Resolve in the first stage-1 PR by emitting `pct` where a phase knows its total and omitting it otherwise; the field is optional in D1 for this reason.
```

- [ ] **Step 4: Write the delta spec `specs/engine-contract/spec.md`**

```markdown
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

> *Technical Note — Emitter in `rust/src/protocol/events.rs` replacing the 84 `eprintln!` calls across 21 files (`grep -rc 'eprintln!' rust/src`); parser in `src/engine/events.ts` replacing `partitionProgress` and `isProgressLine` at `src/engine.ts:136-170` and the regex at `src/error-codes.ts:9`.*

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

**Reason:** replaced by `kesha-engine describe`, which carries the same fields plus the per-command flag schema. **Migration:** the capability-pact recorder (`.github/scripts/record-capability-pacts.ts:117`), its fixtures under `tests/fixtures/capabilities/`, the release install smoke (`.github/scripts/release-install-smoke.sh:52`) and `docs/nix-install.md:15` call `describe` instead.

### Requirement: `--error-codes-json` prints the full error-code taxonomy

**Reason:** folded into the `errors` section of `describe`. **Migration:** `rust/tests/error_codes_cli.rs` and the `docs/errors.md` generator read `describe`.

### Requirement: Engine stderr format is `error [E_CODE]: <message>`

**Reason:** replaced by the event stream. **Migration:** the regex at `src/error-codes.ts:9` and every Rust test asserting `error [` are rewritten against `kind`/`code`.
```

- [ ] **Step 5: Write `tasks.md`**

```markdown
## 1. Engine schema

- [ ] 1.1 Add `Describe` to `Commands` in `rust/src/main.rs` and `rust/src/protocol/describe.rs` that assembles the document from `CommandFactory::command()` plus a gate table
- [ ] 1.2 Unit test: the set of flags clap knows equals the set the gate table lists, per subcommand
- [ ] 1.3 Fold `errors::error_codes_json` and `capabilities::get_capabilities` into the document; delete the two flags

## 2. Event stream

- [ ] 2.1 `rust/src/protocol/events.rs`: `progress`, `warn`, `error`, `debug` emitters writing one JSON object per line to stderr
- [ ] 2.2 Replace every `eprintln!` in `rust/src` (84 calls, 21 files) with an emitter call; `report` in `errors.rs` emits an `error` event
- [ ] 2.3 `say --stdin-loop` status lines become events
- [ ] 2.4 Delete the `KESHA_DEBUG_FD` descriptor path in `rust/src/debug.rs`; debug lines become `debug` events

## 3. Direct consumers

- [ ] 3.1 `record-capability-pacts.ts` and `tests/fixtures/capabilities/*.json` record `describe`
- [ ] 3.2 `release-install-smoke.sh` calls `describe`
- [ ] 3.3 Rust tests `error_codes_cli.rs`, `diarize_e2e.rs`, `kokoro_rate_e2e.rs`, `tts_smoke.rs`, `debug_ndjson_fd.rs` assert on events
- [ ] 3.4 `docs/errors.md` generated from `describe`; `docs/nix-install.md` example updated

## 4. Carrier release

- [ ] 4.1 Tag `v1.25.0-beta.1`, un-draft by hand, verify `kesha install --engine-version 1.25.0-beta.1` downloads it

## 5. CLI (stage 2, tracked here for completeness)

- [ ] 5.1 Pin the beta; `src/engine/describe.ts` with cache, version gate and `validateArgv`
- [ ] 5.2 `src/engine/events.ts` parser and `KeshaError`; delete `src/error-codes.ts`, `preflight*`, `assert*Supported`, `spawnStdioWithDebugFd`
- [ ] 5.3 One PR per command: transcribe, say, install, record, MCP
```

- [ ] **Step 6: Validate and confirm green**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec validate protocol-v4 --type change --strict --no-interactive
bun run check:specs
grep -rnP '[\x{0400}-\x{04FF}]' openspec/changes/protocol-v4 || echo "no cyrillic"
```

Expected: `Change 'protocol-v4' is valid`; `check:specs` reports all baseline specs passed; no Cyrillic. If validate names a requirement, the cause is almost always `SHALL` not on the first body line or a requirement without two scenarios; fix that requirement, do not loosen `--strict`.

- [ ] **Step 7: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
git add openspec/changes/protocol-v4
git commit -m "docs(openspec): propose protocol-v4 (engine describe + stderr event stream)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013RKSL2xGHE1y3njSG8oymq"
```

---

### Task 2: `build-profiles` change (contract C2)

**Files:**
- Create: `openspec/changes/build-profiles/.openspec.yaml`
- Create: `openspec/changes/build-profiles/proposal.md`
- Create: `openspec/changes/build-profiles/design.md`
- Create: `openspec/changes/build-profiles/specs/engine-contract/spec.md`
- Create: `openspec/changes/build-profiles/specs/cli-distribution/spec.md`
- Create: `openspec/changes/build-profiles/tasks.md`

**Interfaces:**
- Consumes: the `profile` field of `describe` named in Task 1 (values `portable` | `darwin`).
- Produces: cargo feature names `portable`, `darwin`; cfg aliases `portable`, `darwin_native`, `system_tts`.

- [ ] **Step 1: Scaffold and confirm red**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec new change "build-profiles"
openspec validate build-profiles --type change --strict --no-interactive; echo "exit=$?"
```

Expected: non-zero exit, no artefacts yet.

- [ ] **Step 2: Write `proposal.md`**

```markdown
# Proposal: build-profiles

## Why

`rust/Cargo.toml` declares seven features (`onnx`, `coreml`, `tts`, `system_tts`, `system_kokoro`, `system_diarize`, `system_text_lang`) and the release matrix ships exactly two combinations: darwin with all six non-ONNX features, every other target with `onnx,tts`. Keeping the matrix equal to cargo's defaults is a CLAUDE.md rule ("BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS") because v1.1.0 shipped without `tts`. The 405 `cfg` attributes use 20 distinct predicates, and `diarize.rs` compiles only under `system_diarize`, which the standard verify set never enables.

## What Changes

- Two **profile features** are added as bundles over the granular ones: `portable = ["onnx", "tts"]` (default) and `darwin = ["coreml", "tts", "system_tts", "system_kokoro", "system_diarize", "system_text_lang"]`.
- Every release row in `build-engine.yml` names exactly one profile, and a test asserts it.
- `build.rs` emits cfg aliases (`portable`, `darwin_native`, `system_tts`) consumed from one `rust/src/platform.rs`; the 20 predicates collapse to at most six.
- `kesha-engine describe` reports `profile`.
- The granular features stay for the four combinations built outside the release matrix: `coreml` alone (`justfile:137`), `coreml,system_diarize` (`rust-test.yml:533`), `coreml,tts,system_tts` (`CONTRIBUTING.md:99`), and Nix on darwin-arm64, `onnx,tts,system_tts` (`flake.nix:59`), which becomes `portable` plus `system_tts`.
- `just preflight` runs `portable` always and `darwin` on macOS; `verify-darwin-full` and the standalone CoreML check fold into that.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `engine-contract`: the Engine names its profile in `describe`.
- `cli-distribution`: the Nix flake builds `portable` plus `system_tts` on darwin.

## Impact

`rust/Cargo.toml`, `rust/build.rs`, `rust/src/platform.rs` (new), every `#[cfg(...)]` site, `.github/workflows/build-engine.yml`, `.github/workflows/rust-test.yml`, `justfile`, `flake.nix`, `CONTRIBUTING.md`, `CLAUDE.md` (two rules deleted).

## Non-goals

- Removing any granular feature or changing what a shipped binary contains.
- Making Nix build the CoreML path (its sandbox cannot clone the SwiftPM dependency).
- Changing the release matrix's targets or runners.
```

- [ ] **Step 3: Write `design.md`**

```markdown
## Context

`rust/Cargo.toml` `[features]`: `default = ["onnx", "tts"]`, `coreml = ["dep:fluidaudio-rs"]`, `tts = [...]`, `system_tts = ["tts"]`, `system_kokoro = ["tts", "dep:fluidaudio-rs"]`, `system_diarize = ["dep:fluidaudio-rs"]`, `system_text_lang = []`. `build-engine.yml:106-116` ships two rows. Distinct `cfg` predicates: 20 (`grep -rhoE '#\[cfg\([^]]+\)\]' rust/src | sort -u`).

## Goals / Non-Goals

Goals: a shipped binary is described by one word; the release-row invariant is a test, not a CLAUDE.md rule; platform branching reads as `#[cfg(darwin_native)]`. Non-goals: as in the proposal.

## Decisions

### D1. Profiles are bundles, granular features stay

```toml
[features]
default = ["portable"]
portable = ["onnx", "tts"]
darwin = ["coreml", "tts", "system_tts", "system_kokoro", "system_diarize", "system_text_lang"]
```

The granular features are not removed because four non-release builds need them (proposal). `onnx` and `coreml` stay mutually exclusive at module level as today (`rust/src/backend/mod.rs:7-10`).

### D2. cfg aliases from `build.rs`

`build.rs` emits `cargo:rustc-check-cfg` and `cargo:rustc-cfg` for `portable` (feature `onnx` and not `coreml`), `darwin_native` (feature `coreml` on `target_os = "macos"`) and `system_tts` (feature `system_tts` on macOS). Source uses `#[cfg(darwin_native)]`, never the six-way `all(feature = "...", target_os = "macos")` spelling. `rust/src/platform.rs` is the only module that mentions the raw features, exposing `pub const PROFILE: &str`.

### D3. Release rows name a profile

`build-engine.yml` rows become `features: darwin` and `features: portable` with `--no-default-features`; `tests/unit/check-workflows.test.ts` gains the assertion "every `build-engine.yml` row's `features` is exactly one of `portable`, `darwin`", replacing the CLAUDE.md matrix rule.

### D4. Gates

`just preflight`: `cargo nextest run --features portable` always; on macOS also `cargo clippy --all-targets --features darwin --no-default-features -- -D warnings` and `cargo nextest run --features darwin`. `rust-test.yml` mirrors that. The standalone `cargo check --features coreml` (`justfile:137`) is deleted; the diarize lane (`rust-test.yml:533`) keeps `coreml,system_diarize` because it exists to measure diarize in isolation.

## Risks / Trade-offs

- Mac contributors without Xcode: `portable` builds without `swiftc`; `darwin` needs Xcode Command Line Tools and the preflight says so when `swiftc` is missing.
- Local `darwin` builds compile the Swift sidecars every time; today's `coreml`-only check avoided that. Accepted: the check was the reason `diarize.rs` went unverified.

## Migration Plan

Stage 3 (parallel to stages 1–2, 2–3 PRs): Cargo profiles + aliases + `platform.rs`; then the workflow/justfile/flake rows; then the CLAUDE.md deletions.

## Open Questions

- None.
```

- [ ] **Step 4: Write the delta spec `specs/engine-contract/spec.md`**

```markdown
## ADDED Requirements

### Requirement: The Engine names its release profile

The `describe` document SHALL carry `profile`, whose value is `portable` or `darwin`, and every Engine binary published on a release SHALL have been built from exactly one of those two profiles; a release row that names any other feature set SHALL fail the workflow check before a build starts.

#### Scenario: Maks reads which profile his Engine is

- GIVEN the darwin-arm64 Engine from a release
- WHEN the CLI runs `kesha-engine describe`
- THEN `profile` is `"darwin"` and `backend` is `"coreml"`

#### Scenario: A release row drifts from the profiles

- GIVEN a `build-engine.yml` row whose `features` is `onnx` without `tts`
- WHEN the workflow lint runs in CI
- THEN it fails naming the row and the two allowed profiles

> *Technical Note — `PROFILE` in `rust/src/platform.rs`; the row assertion joins `.github/scripts/check-workflows.ts`; the rows today are `.github/workflows/build-engine.yml:106-116`.*
```

- [ ] **Step 5: Write the delta spec `specs/cli-distribution/spec.md`**

```markdown
## MODIFIED Requirements

### Requirement: The Nix flake is an alternate build path, and never a release gate

The Nix flake SHALL define a from-source Engine build for `aarch64-darwin` and `x86_64-linux` using the `portable` profile, adding `system_tts` on darwin so the AVSpeech Sidecar is exercised, and MAY define the CLI pointed at the Engine the same flake built. Only the Engine derivation (`.#kesha-engine`) SHALL be presented as a usable Nix path; the CLI derivation (`.#kesha`) SHALL NOT be documented as a working install method while its dependency derivation's output hash is an unpopulated placeholder. No published artifact SHALL depend on the flake, so a flake that does not build blocks nothing.

#### Scenario: Maks builds the Engine through Nix

- GIVEN Maks has Nix with flakes enabled on Apple Silicon
- WHEN Maks runs `nix build .#kesha-engine`
- THEN the Engine is built from source with `profile` reporting `portable`
- AND the `say-avspeech` Sidecar is present beside it

#### Scenario: The CLI Nix path is not presented as an install method

- GIVEN the CLI's dependency derivation carries a placeholder output hash
- WHEN a user reads the README or `docs/nix-install.md`
- THEN no doc presents `nix run` / `nix profile install .#kesha` as a working install method
- AND no release lane fails as a result

> *Technical Note — `rustFeatures` at `flake.nix:59-61` becomes `"portable,system_tts"` on darwin-arm64 and `"portable"` elsewhere; the rationale comment at `flake.nix:47-58` (SwiftPM clone fails offline) stays.*
```

- [ ] **Step 6: Write `tasks.md`**

```markdown
## 1. Cargo

- [ ] 1.1 Add `portable` and `darwin` bundle features; `default = ["portable"]`
- [ ] 1.2 `build.rs`: emit `portable`, `darwin_native`, `system_tts` cfg aliases with `rustc-check-cfg`
- [ ] 1.3 `rust/src/platform.rs` with `PROFILE`; rewrite every `#[cfg(all(feature = ..., target_os = "macos"))]` to an alias; assert `grep -rhoE '#\[cfg\([^]]+\)\]' rust/src | sort -u | wc -l` ≤ 6

## 2. Rows and gates

- [ ] 2.1 `build-engine.yml` rows: `features: darwin` / `features: portable`
- [ ] 2.2 `check-workflows.ts` + test: each row names exactly one profile
- [ ] 2.3 `justfile` preflight: `portable` always, `darwin` on macOS; delete the standalone CoreML check and `verify-darwin-full`
- [ ] 2.4 `rust-test.yml` mirrors the justfile; `preflight-parity.test.ts` asserts the Rust profile commands match
- [ ] 2.5 `flake.nix` and `CONTRIBUTING.md` speak in profiles

## 3. Docs

- [ ] 3.1 Delete "BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS" and the darwin caveat in "VERIFY BEFORE PUSHING" from CLAUDE.md; move "COREML BUILD TRIPLE" points 1–2 to a comment on the `darwin` profile
```

- [ ] **Step 7: Validate, check, commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec validate build-profiles --type change --strict --no-interactive
bun run check:specs
grep -rnP '[\x{0400}-\x{04FF}]' openspec/changes/build-profiles || echo "no cyrillic"
git add openspec/changes/build-profiles
git commit -m "docs(openspec): propose build-profiles (portable/darwin bundles over cargo features)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013RKSL2xGHE1y3njSG8oymq"
```

Expected: `Change 'build-profiles' is valid`, baseline specs pass, commit lands.

---

### Task 3: `core-api-v2` change (contract C3)

**Files:**
- Create: `openspec/changes/core-api-v2/.openspec.yaml`
- Create: `openspec/changes/core-api-v2/proposal.md`
- Create: `openspec/changes/core-api-v2/design.md`
- Create: `openspec/changes/core-api-v2/specs/programmatic-api/spec.md`
- Create: `openspec/changes/core-api-v2/tasks.md`

**Interfaces:**
- Consumes: `KeshaError { code, hint }` and the `describe` document from Task 1.
- Produces: the Core API surface — `transcribe(path, opts?) -> Promise<TranscribeResult>`, `say(opts) -> Promise<Uint8Array>`, `install(opts?) -> Promise<void>` with `{ engine?: boolean; tts?: string[]; vad?: boolean; diarize?: boolean; noCache?: boolean }`, `capabilities() -> Promise<EngineDescription>`, `toToon(results)`, `KeshaError`.

- [ ] **Step 1: Scaffold and confirm red**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec new change "core-api-v2"
openspec validate core-api-v2 --type change --strict --no-interactive; echo "exit=$?"
```

Expected: non-zero exit.

- [ ] **Step 2: Write `proposal.md`**

```markdown
# Proposal: core-api-v2

## Why

The Core API carries three aliases whose names no longer say what they do: `downloadModel` installs the Engine binary, `downloadCoreML` is a deprecated alias of it, and `transcribeWithSegments` is a deprecated alias of `transcribeWithTimestamps`. `transcribe` returns a bare string while every other consumer of a transcript (the CLI, MCP, TOON) works on the structured result. Errors reach Sona as plain `Error` with the code buried in the message, except `SayError`, which carries one.

## What Changes

- `transcribe(path, opts?)` returns `TranscribeResult`; the text is `.text`. `transcribeWithTimestamps` and `transcribeWithSegments` are removed; `opts.timestamps` selects segments.
- `install(opts?)` replaces `downloadModel`, `downloadEngine`, `downloadCoreML` and `downloadTts`; one call, one options object mirroring `kesha install` flags.
- `capabilities()` exposes the `describe` document.
- Every rejection is a `KeshaError` with `code` and, when known, `hint`; `SayError` becomes `KeshaError`.
- The exported types drop `TranscriptionOutput` and add `EngineDescription`; `TranscribeResult` and the `kesha status --json` shape are unchanged.
- Ships in CLI 2.0.0.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `programmatic-api`: `transcribe` returns a structured result; installer functions collapse into `install`; `capabilities()` and `KeshaError` are added; the exported type list changes.

## Impact

`src/lib.ts`, `src/transcribe.ts`, `src/synth.ts`, `src/engine-install.ts` (signature only), `docs/api.md`, `docs/architecture.md:265`, `CLAUDE.md:207`, `openspec/specs/GLOSSARY.md:53` (Core API entry), `CHANGELOG.md`, `tests/unit/lib.test.ts`; the in-flight `engine-version-override` change references `downloadModel` in its design and is updated when it lands or archived.

## Non-goals

- Changing `TranscribeResult`, `TranscribeErrorRecord`, `TranscribeJsonOutput` or the TOON encoding.
- Adding new capabilities to the API (streaming, recording); those are separate proposals.
- Keeping deprecated aliases: 2.0.0 is the major release that removes them.
```

- [ ] **Step 3: Write `design.md`**

```markdown
## Context

Baseline `programmatic-api`: `transcribe -> Promise<string>` (`src/lib.ts:44`), `transcribeWithTimestamps` (`src/lib.ts:60`), alias `transcribeWithSegments` (`src/lib.ts:74`), `downloadModel`/`downloadEngine`/`downloadCoreML` (`src/lib.ts:11,42`), `downloadTts` (`src/lib.ts:36`), `SayError` (`src/synth.ts`). The only external references to the removed names outside `src/` and tests: `docs/api.md:7-9`, `docs/architecture.md:265`, `CLAUDE.md:207`, `openspec/specs/programmatic-api/spec.md:78-184`, `openspec/specs/GLOSSARY.md:53`, `openspec/changes/engine-version-override/design.md:129-131`, `CHANGELOG.md:123,175`.

## Goals / Non-Goals

Goals: names say what they do; one result shape; one error type. Non-goals: as in the proposal.

## Decisions

### D1. Surface

```ts
export function transcribe(path: string, opts?: TranscribeOptions): Promise<TranscribeResult>;
export function say(opts: SayOptions): Promise<Uint8Array>;
export function install(opts?: InstallOptions): Promise<void>;
export function capabilities(): Promise<EngineDescription>;
export function toToon(results: TranscribeResult[], errors?: TranscribeErrorRecord[]): string;
export class KeshaError extends Error { readonly code: string; readonly hint?: string }
export type InstallOptions = { engine?: boolean; tts?: string[]; vad?: boolean; diarize?: boolean; noCache?: boolean; engineVersion?: string };
export type { TranscribeOptions, TranscribeResult, TranscribeErrorRecord, TranscribeJsonOutput, TranscriptionSegment, WordTiming, SayOptions, VadMode, EngineDescription };
```

`install()` with no options installs the Engine and ASR models, exactly what `kesha install` does; `tts: ["en"]` mirrors `--tts en`. The never-auto-download rule is unchanged: `transcribe` and `say` throw `E_ENGINE_SPAWN` with a hint when the Engine is missing and never call `install`.

### D2. `transcribe` result

`transcribe` resolves to the same `TranscribeResult` the CLI emits under `--json` for one file: `file`, `text`, `lang`, optional `audioLanguage`, `textLanguage`, `segments`, `sttTimeMs`. With `opts.timestamps` or `opts.speakers`, `segments` is populated; otherwise it is absent. A missing file rejects with `KeshaError` `E_INPUT_NOT_FOUND` before any spawn.

### D3. Errors

`KeshaError` is the only rejection type. `code` is a published Error code (Engine or CLI origin, both listed by `describe`); `hint` is the remedy the CLI would print. `SayError` is removed; its `code` semantics carry over unchanged.

## Risks / Trade-offs

- Every existing programmatic caller breaks on 2.0.0. Accepted and announced in CHANGELOG "Breaking"; the rename map is one table.

## Migration Plan

Stage 4, one PR: `src/lib.ts` rewrite, `docs/api.md` rewrite with the rename table, `CLAUDE.md:207`, `docs/architecture.md:265`, GLOSSARY entry, tests.

## Open Questions

- None.
```

- [ ] **Step 4: Write the delta spec `specs/programmatic-api/spec.md`**

```markdown
## ADDED Requirements

### Requirement: `install(opts?)` is the one programmatic installer

The Core API SHALL expose `install(opts?)`, which performs what `kesha install` performs for the same options: `engine` (default true), `tts` (a list of language codes, default none), `vad`, `diarize`, `noCache`, `engineVersion`. It SHALL be the only exported function that downloads anything.

#### Scenario: Sona installs the Engine and English TTS from her setup script

- WHEN Sona calls `await install({ tts: ["en"] })`
- THEN the Engine binary and the English TTS models are present in the Model cache
- AND subsequent `transcribe` and `say` calls succeed

#### Scenario: Diarize requested where it cannot be served

- GIVEN the platform is not darwin-arm64
- WHEN Sona calls `await install({ diarize: true })`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_UNSUPPORTED_PLATFORM`
- AND nothing was downloaded

> *Technical Note — Wraps `installEngine` in `src/engine-install.ts` (today reached through `downloadEngine` at `src/lib.ts:11` and `downloadTts` at `src/lib.ts:36`).*

### Requirement: `capabilities()` exposes the Engine's schema

The Core API SHALL expose `capabilities()`, resolving to the `describe` document of the installed Engine, so Sona can feature-gate her agent without spawning the Engine herself.

#### Scenario: Sona checks for diarization before offering it

- GIVEN a darwin-arm64 Engine is installed
- WHEN Sona calls `await capabilities()`
- THEN `features` contains `transcribe.diarize` and `profile` is `darwin`

#### Scenario: No Engine installed

- GIVEN the Engine binary is absent
- WHEN Sona calls `await capabilities()`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_ENGINE_SPAWN` and whose `hint` names `kesha install`

> *Technical Note — Reads through the cached `describe` in `src/engine/describe.ts` (protocol-v4 change).*

### Requirement: Every rejection is a `KeshaError`

Every promise the Core API returns SHALL reject with a `KeshaError` carrying `code` (a published Error code) and, when a remedy is known, `hint`; no Core API function SHALL reject with a bare `Error`.

#### Scenario: Engine failure surfaces its code

- GIVEN the ASR model is not installed
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the rejection is a `KeshaError` with `code` `E_MODEL_MISSING` and a `hint` naming `kesha install`

#### Scenario: A CLI-side failure uses the same type

- WHEN Sona calls `await transcribe("ghost.ogg")`
- THEN the rejection is a `KeshaError` with `code` `E_INPUT_NOT_FOUND`
- AND `message` contains `ghost.ogg`

> *Technical Note — `KeshaError` in `src/engine/events.ts`; replaces `SayError` (`src/synth.ts`) and the `Error("File not found: ...")` at `src/lib.ts:46`.*

## MODIFIED Requirements

### Requirement: `transcribe(path, opts?)` returns the transcript text

`transcribe` SHALL accept an audio file path and an optional `TranscribeOptions` object and SHALL resolve to a `TranscribeResult` — the same shape one file produces under `kesha --json` — whose `text` is the transcript and whose `segments` is present only when `opts.timestamps` or `opts.speakers` was set. It SHALL reject with `KeshaError` `E_INPUT_NOT_FOUND` before spawning the Engine when the file does not exist, SHALL NOT surface Engine events on the caller's stderr, and SHALL reject with the Engine's Error code when the Engine fails.

#### Scenario: Sona transcribes a voice note

- GIVEN the Engine and ASR models are installed and `note.ogg` exists
- WHEN Sona calls `const r = await transcribe("note.ogg")`
- THEN `r.text` is the transcript and `r.file` is `"note.ogg"`
- AND `r.segments` is undefined
- AND nothing appears on the caller's stderr

#### Scenario: Timestamps requested

- WHEN Sona calls `await transcribe("note.ogg", { timestamps: true })`
- THEN the result's `segments` is an array of `TranscriptionSegment`

#### Scenario: File does not exist

- WHEN Sona calls `await transcribe("ghost.ogg")`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_INPUT_NOT_FOUND`

> *Technical Note — `src/lib.ts:44-70` today; `transcribeWithTimestamps` (`src/lib.ts:60`) and the alias `transcribeWithSegments` (`src/lib.ts:74`) are removed by this change.*

### Requirement: Exported types cover the full public surface

The Core API SHALL export the following TypeScript types: `TranscribeResult`, `TranscribeOptions`, `TranscribeErrorRecord`, `TranscribeJsonOutput`, `TranscriptionSegment`, `WordTiming`, `SayOptions`, `InstallOptions`, `EngineDescription`, `VadMode`, and the class `KeshaError`. These SHALL NOT change shape without a major version bump.

#### Scenario: Sona types her wrapper function

- WHEN Sona writes `import type { SayOptions, InstallOptions } from "@drakulavich/kesha-voice-kit/core"`
- THEN the TypeScript compiler resolves both types without error

#### Scenario: A removed type is imported

- WHEN Sona writes `import type { TranscriptionOutput } from "@drakulavich/kesha-voice-kit/core"`
- THEN the TypeScript compiler reports that the module has no such export

> *Technical Note — Today's list at `src/lib.ts:9-31`; `TranscriptionOutput` and `SayError` leave, `WordTiming` (already exported at `src/lib.ts:10`), `InstallOptions`, `EngineDescription` and `KeshaError` join.*

## REMOVED Requirements

### Requirement: `transcribeWithTimestamps(path, opts?)` returns text and segments

**Reason:** `transcribe` returns the structured result; `opts.timestamps` selects segments. **Migration:** `transcribeWithTimestamps(p, o)` becomes `transcribe(p, { ...o, timestamps: true })`; `transcribeWithSegments` likewise.

### Requirement: `downloadModel` / `downloadEngine` installs the Engine binary

**Reason:** the name said "model" and installed the Engine; replaced by `install()`. **Migration:** `downloadModel()` becomes `install()`; `downloadCoreML()` likewise.

### Requirement: `downloadTts(noCache?, langs?)` installs TTS models

**Reason:** folded into `install({ tts, noCache })`. **Migration:** `downloadTts(false, ["en", "ru"])` becomes `install({ engine: false, tts: ["en", "ru"] })`.
```

- [ ] **Step 5: Write `tasks.md`**

```markdown
## 1. Surface

- [ ] 1.1 Rewrite `src/lib.ts` to the D1 surface; `transcribe` returns `TranscribeResult`
- [ ] 1.2 `install()` over `installEngine`; delete `downloadModel`, `downloadEngine` export, `downloadCoreML`, `downloadTts`
- [ ] 1.3 `capabilities()` over the cached `describe`
- [ ] 1.4 Replace `SayError` with `KeshaError`; every rejection path constructs one

## 2. Tests and docs

- [ ] 2.1 `tests/unit/lib.test.ts`: the three scenarios per requirement above; delete the alias tests
- [ ] 2.2 `docs/api.md` rewritten with a rename table; `docs/architecture.md:265`, `CLAUDE.md:207`, GLOSSARY "Core API" entry updated
- [ ] 2.3 CHANGELOG "Breaking" section for 2.0.0
```

- [ ] **Step 6: Validate, check, commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec validate core-api-v2 --type change --strict --no-interactive
bun run check:specs
grep -rnP '[\x{0400}-\x{04FF}]' openspec/changes/core-api-v2 || echo "no cyrillic"
git add openspec/changes/core-api-v2
git commit -m "docs(openspec): propose core-api-v2 (structured transcribe, install(), KeshaError)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013RKSL2xGHE1y3njSG8oymq"
```

Expected: `Change 'core-api-v2' is valid`, baseline specs pass.

---

### Task 4: `unified-release` change (contracts C4 + C5)

**Files:**
- Create: `openspec/changes/unified-release/.openspec.yaml`
- Create: `openspec/changes/unified-release/proposal.md`
- Create: `openspec/changes/unified-release/design.md`
- Create: `openspec/changes/unified-release/specs/release-channels/spec.md`
- Create: `openspec/changes/unified-release/specs/installation/spec.md`
- Create: `openspec/changes/unified-release/tasks.md`

**Interfaces:**
- Consumes: profile names from Task 2 for the release rows; the beta carrier from Task 1.
- Produces: tag grammar `vX.Y.Z`, `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N` (no `-cli`); workflow names `ci.yml`, `nightly.yml`, `release.yml`, `security.yml`; the engine-pin derivation rule.

- [ ] **Step 1: Scaffold and confirm red**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec new change "unified-release"
openspec validate unified-release --type change --strict --no-interactive; echo "exit=$?"
```

Expected: non-zero exit.

- [ ] **Step 2: Write `proposal.md`**

```markdown
# Proposal: unified-release

## Why

The CLI (1.29.1) and the Engine (1.24.11) are versioned and tagged independently: bare `vX.Y.Z` for the Engine, `vX.Y.Z-cli` for the CLI, a draft-plus-un-draft gate, and a post-release job that bumps the CLI's Pinned Engine version. Keeping that consistent costs ~1.9k script lines, ~1.6k workflow lines and ~2.2k test lines, spread over 12 workflows and ~20 scripts in four languages; those files are the highest-churn files in the repository. Since mid-May there were 15 Engine and 13 CLI-only releases, often on the same day. An Engine build takes ~9 minutes.

## What Changes

- **One version.** `package.json#version` is the version of both artifacts; `rust/Cargo.toml` mirrors it and `check:versions` keeps them equal. The `keshaEngine.version` field is removed from `package.json`.
- **One stable tag.** `vX.Y.Z` builds the three Engine binaries and Sidecars, smoke-tests each asset, creates the GitHub release, publishes npm with provenance, and updates the tap, `.deb`/`.rpm`, Docker and the Nix version file — as jobs of one `release.yml`, in dependency order, never through `release: published` events (a `GITHUB_TOKEN`-created release fires none).
- **Two Prerelease channels stay.** `-alpha.N` (auto-published per qualifying merge, pruned after 30 days) and `-beta.N` (dispatched, draft, un-drafted by hand, never pruned, and the only Prerelease the CLI may pin as its Engine). The `-cli` marker and the post-release pin bump are removed.
- **The Engine pin is derived at publish time**, never committed: a stable CLI release resolves the Engine of its own version; a CLI alpha resolves the newest stable Engine, or the Engine Prerelease named by the dispatcher; a CLI beta resolves the Engine beta of the same version.
- **Four workflows.** `ci.yml` (PR gate; `🧪 CI`, `🧪 Rust Tests` and `🛡️ Security Audit` keep their names as required checks), `nightly.yml` (the six schedule-only workflows as jobs), `release.yml`, `security.yml`. `actionlint` joins CI; `check-workflows.ts` keeps only repository-specific invariants. Scripts move to TypeScript under bun.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `release-channels`: a tag names one version of both artifacts; alphas derive their Engine; one publish path is a workflow, not an event chain.
- `installation`: pre-release verification runs on the built assets before publication; Linux packages ship from the same stable tag.

## Impact

`package.json`, `.github/scripts/check-versions.ts`, `.github/workflows/*` (23 → 4), `.github/scripts/*` (60 → ≤25), `packaging/homebrew/Formula/kesha-voice-kit.rb`, `flake.nix:173`, `docs/homebrew.md`, `docs/linux-packages.md`, `docs/release-manifest.md`, `docs/nix-install.md` (merged into `docs/distribution.md`), the `release-engine`, `release-cli` and `release-mechanics` skills (merged into one `release` skill), `CLAUDE.md` Releases section, `tests/unit/*release*`, `tests/integration/alpha-tag.test.ts`, `build-engine-tag-guard.test.ts`, `push-annotated-tag.test.ts`.

## Non-goals

- Changing what any Distribution path installs or where the Model cache lives.
- Removing the alpha or beta channel.
- Changing the engine asset names or the release manifest schema.
```

- [ ] **Step 3: Write `design.md`**

```markdown
## Context

Tags today: `release-tags.mjs:11-39` (`vX.Y.Z`, `-beta.N`, `-alpha.N`, `-cli` marker). Draft/un-draft: `classify-release-tag.mjs:5-10`. Pin refusal for alphas: `check-versions.ts:82-91`. Event-triggered downstream: `npm-publish.yml:18-20`, `homebrew-tap.yml:3-5`, `post-engine-release.yml:3-5`; explicit dispatch workaround: `dispatch-npm-publish.sh:15`. Linux packages keyed on the `-cli` marker: `linux-packages.yml:43`. Docker excludes alphas: `docker.yml:6`. Nix writes an Engine version marker from `package.json#keshaEngine.version`: `flake.nix:173`.

## Goals / Non-Goals

Goals: one number to bump; one workflow to read; no event cascade to reason about; alphas keep rehearsing the path. Non-goals: as in the proposal.

## Decisions

### D1. Version and pin

`package.json#version` is the only version. The CLI resolves its Engine as: stable `X.Y.Z` → Engine `vX.Y.Z`; beta `X.Y.Z-beta.N` → Engine `vX.Y.Z-beta.N`; alpha `X.Y.Z-alpha.N` → the newest stable Engine tag at publish time unless the dispatcher passes `engine-prerelease: vX.Y.Z-beta.N`. The resolution is written into the published package (`package.json#kesha.engine` at publish, injected the way alpha versions are injected today) and never committed to `main`. `check:versions` rule 3 becomes: `main` carries no pin field at all.

Why not build an Engine per CLI alpha: `release-channels` requires Engine alphas to be deliberate, and 4 merges a day × 9 min × 3 runners is real money for a rehearsal that changes no Engine bytes.

### D2. `release.yml`

Triggered by `push: tags: [v*]` and `workflow_dispatch` (alpha with an explicit `engine-prerelease`). Jobs: `classify` (tag → channel; refuses any tag not matching `^v\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$`), `build-engine` (matrix of two profiles), `smoke` (downloads the just-built assets as artifacts, runs `describe`, `say`, `transcribe` round-trip per platform), `github-release` (draft for stable and beta, published for alpha), `npm` (`workflow_call` into the publish job with provenance; skipped for beta), `packages` (`.deb`/`.rpm`, stable only), `homebrew`, `docker`, `nix-version`. Every downstream job `needs:` its upstream; nothing subscribes to `release:` events. Stable and beta stay draft until a person un-drafts; the assets were already smoke-tested, so un-drafting is a publication decision, not a validation step.

### D3. Alpha and beta

Alpha keeps `release-alpha.yml`'s derivation logic (`derive-alpha-version.ts`, `alpha-publishable.ts`) as jobs inside `release.yml` on `push` to `main`; the derived version is `X.Y.Z-alpha.N` and the Engine pin follows D1. Beta is dispatched with a version and builds the Engine; it is the carrier for the v2 migration (design spec section 4) and is never pruned.

### D4. `nightly.yml`

Jobs: `capability-pact`, `cargo-dependency-maintenance`, `mini-model-pact`, `model-plan-size-canary`, `prune-alpha-releases`, `real-model-canary`, each with the schedule and permissions it has today, each independently dispatchable through a `job` input.

### D5. Lint

`actionlint` runs in `ci.yml` and owns pinned action SHAs, shell selection, timeouts and expression syntax; `check-workflows.ts` keeps `requirePactVerificationCoversEveryTarget`, `requireRestoreOnlyCachesHaveAWriter`, `requireNpmPublishAfterPackaging` and the profile-row assertion from `build-profiles`.

## Risks / Trade-offs

- A CLI-only fix now rebuilds the Engine (~9 min, ~190 MB re-uploaded). Accepted.
- An Engine hotfix is also a CLI release. Accepted; one CHANGELOG stream.
- Deleting twelve workflows in one PR is unreviewable; one workflow per PR.

## Migration Plan

Stage 4, 8–12 PRs after `core-api-v2`: `release.yml` skeleton with `classify` + `build-engine` + `smoke`; then npm; then packages/tap/docker/nix; then alpha derivation moves in; then one deletion PR per old workflow; then `nightly.yml`; then `actionlint` + `check-workflows.ts` cut; then docs and skills; then tag `v2.0.0`.

## Open Questions

- Whether Homebrew's formula should install the Engine too (today it installs the CLI from the tag tarball and the CLI downloads the Engine on `kesha install`). Out of scope; the formula changes only its version source.
```

- [ ] **Step 4: Write the delta spec `specs/release-channels/spec.md`**

```markdown
## ADDED Requirements

### Requirement: The CLI's Engine is resolved at publish time, never committed

A published CLI SHALL name the Engine it resolves, and that name SHALL be derived when the CLI is published rather than stored in the default branch: a stable CLI resolves the Engine of its own version, a beta resolves the Engine beta of its own version, and an alpha resolves the newest stable Engine unless the person dispatching it names an Engine Prerelease.

#### Scenario: A CLI alpha after a docs-only Engine period

- GIVEN the newest stable Engine is `v2.1.0` and no Engine change has merged since
- WHEN a qualifying merge publishes CLI `2.2.0-alpha.3`
- THEN that alpha resolves Engine `v2.1.0`
- AND no Engine build ran for it

#### Scenario: The default branch carries a pin

- GIVEN a pull request adds an Engine pin field to `package.json`
- WHEN `check:versions` runs
- THEN it fails naming the field and this requirement

> *Technical Note — Replaces `package.json#keshaEngine.version` and rule 3 at `.github/scripts/check-versions.ts:82-91`; injection at publish reuses the alpha version injection in `npm-publish.yml:104-106`.*

## MODIFIED Requirements

### Requirement: A tag names exactly one artifact and one channel

Every release tag SHALL name one version of both artifacts and one Channel by its shape alone: `vX.Y.Z` is stable, `vX.Y.Z-alpha.N` is alpha, `vX.Y.Z-beta.N` is beta, and no other shape SHALL start any release work. A pipeline SHALL decide what to do with a tag without inspecting the commit it points at.

#### Scenario: A stable tag publishes both artifacts

- GIVEN Maks pushes `v2.0.0`
- WHEN the release workflow classifies it
- THEN it builds the Engine, verifies the assets, and publishes the CLI at `2.0.0` resolving Engine `v2.0.0`

#### Scenario: A legacy marker tag is refused

- GIVEN a tag `v2.0.1-cli` is pushed
- WHEN the release workflow classifies it
- THEN it fails before building, naming the accepted shapes

> *Technical Note — Grammar today at `.github/scripts/release-tags.mjs:11-39`; the `-cli` arm is deleted.*

### Requirement: CLI alphas publish on every merge that changes the CLI

Every push to the default branch that changes CLI sources SHALL produce a published CLI alpha without further human action, resolving its Engine as the previous requirement states; a merge that changes nothing a user could run SHALL NOT produce an alpha. Publishing SHALL remain a pipeline action performed with provenance, never from a workstation.

#### Scenario: A merge to the default branch produces an alpha

- GIVEN a pull request changing CLI sources merges to the default branch
- WHEN the release workflow's alpha jobs run
- THEN a CLI alpha is published on the alpha Channel resolving the newest stable Engine
- AND its release notes list the commits since the previous alpha

#### Scenario: A docs-only merge publishes nothing

- GIVEN a pull request that changes only documentation merges
- WHEN the alpha jobs evaluate the change
- THEN no alpha is published
- AND the run records that it deliberately skipped

> *Technical Note — `derive-alpha-version.ts` and `alpha-publishable.ts` move under `release.yml`; behaviour is unchanged except the Engine resolution.*

### Requirement: Alpha and stable publish through one path

The steps that publish a build SHALL exist once, as jobs of one release workflow invoked by every Channel, and every downstream publication (npm, Homebrew tap, Linux packages, container image, Nix version) SHALL run as a job that depends on the job that built and verified the assets, never as a reaction to a GitHub release event. A Channel SHALL differ from another only in the inputs it supplies.

#### Scenario: A change to the publish path is rehearsed

- GIVEN the shared publish jobs are modified
- WHEN the next alpha publishes
- THEN that alpha exercised the modified jobs
- AND a subsequent stable release runs the same jobs

#### Scenario: A release created by the workflow reaches npm

- GIVEN the release workflow created the GitHub release with its own token
- WHEN the npm job runs
- THEN it runs because it depends on the release job, not because an event fired
- AND the package on npm resolves the Engine that release carries

> *Technical Note — Today npm, tap and post-release listen to `release: published` (`npm-publish.yml:18-20`, `homebrew-tap.yml:3-5`, `post-engine-release.yml:3-5`) and `dispatch-npm-publish.sh:15` works around the missing event; `release.yml` replaces all three with `needs:`.*
```

- [ ] **Step 5: Write the delta spec `specs/installation/spec.md`**

```markdown
## MODIFIED Requirements

### Requirement: Every shipped platform is verified end to end before release

The release pipeline SHALL verify, for each platform whose Engine is published on the stable Channel, that the built asset performs real synthesis and real Transcription before the release is created — by downloading the just-built asset as a workflow artifact, running `describe`, `kesha say` and a transcription of the result — and SHALL refuse to create the release when any platform fails. A platform whose Engine ships without that verification SHALL be documented as unverified. Because the install-time ASR warm-up is non-fatal by design, a successful `kesha install` SHALL NOT by itself count as verification. Engine assets on the alpha Channel SHALL NOT be presented as verified and SHALL NOT change the platform support matrix.

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

#### Scenario: An alpha Engine does not change the support matrix

- GIVEN an Engine alpha is published for a platform
- WHEN Ira consults the platform matrix
- THEN the matrix reflects the stable Channel only

> *Technical Note — Replaces the post-publication `published-engine-smoke` lane (`ci.yml:518`) and `release-install-smoke.yml`; the smoke script is `.github/scripts/smoke-synthesis.ts`, invoked on artifacts instead of on a downloaded release.*

### Requirement: Linux packages ship only from a release that publishes the same CLI version

A `.deb` or `.rpm` SHALL be published only by the stable release whose version it carries, and that release SHALL publish the same version to npm in the same run. The packaged version is `package.json#version` at the tag, so the release SHALL refuse a tag whose version differs from it. Prerelease tags SHALL ship no packages.

#### Scenario: Maks installs the CLI from apt

- GIVEN a stable tag `vX.Y.Z` is pushed
- WHEN the release workflow runs
- THEN it attaches the `.deb`, the `.rpm` and their `SHA256SUMS` to that release
- AND it publishes `X.Y.Z` to npm in the same run

#### Scenario: The tag names a version the commit does not carry

- GIVEN a tag whose version differs from `package.json#version` at that tag
- WHEN the release workflow classifies it
- THEN it fails before building, naming both versions

#### Scenario: A Prerelease tag is pushed

- GIVEN a tag on the beta or alpha Channel
- WHEN the release workflow runs
- THEN the packages job is skipped and says why

> *Technical Note — `linux-packages.yml:43` keys on the `-cli` marker today; the `packages` job of `release.yml` keys on the stable Channel.*
```

- [ ] **Step 6: Write `tasks.md`**

```markdown
## 1. Version

- [ ] 1.1 Remove `package.json#keshaEngine.version`; `check:versions` asserts `package.json#version == Cargo.toml version` and that no pin field exists
- [ ] 1.2 `src/install/execute.ts` resolves the Engine from `package.json#kesha.engine` injected at publish, falling back to `version`

## 2. `release.yml`

- [ ] 2.1 Skeleton: `classify` → `build-engine` (two profile rows) → `smoke` on artifacts → `github-release`
- [ ] 2.2 `npm` job via `workflow_call` with provenance; beta skipped
- [ ] 2.3 `packages`, `homebrew`, `docker`, `nix-version` jobs with `needs:`
- [ ] 2.4 Alpha derivation jobs moved in from `release-alpha.yml`

## 3. Deletions, one PR each

- [ ] 3.1 `build-engine.yml` 3.2 `release-cli.yml` 3.3 `release-npm-publish.yml` 3.4 `npm-publish.yml` 3.5 `post-engine-release.yml` 3.6 `release-install-smoke.yml` 3.7 `homebrew-tap.yml` 3.8 `linux-packages.yml` 3.9 `docker.yml` 3.10 `release-alpha.yml` 3.11 `prune-alpha-releases.yml` (into nightly) 3.12 `cache-seed.yml`/`cache-cleanup.yml`/`cross-os-cache-probe.yml` (into `ci.yml` or `nightly.yml`)

## 4. `nightly.yml`, lint, docs

- [ ] 4.1 `nightly.yml` with the six canary jobs
- [ ] 4.2 `actionlint` in `ci.yml`; cut `check-workflows.ts` to the four repository-specific rules
- [ ] 4.3 `docs/distribution.md` from the four distribution docs; one `release` skill; CLAUDE.md Releases section to one paragraph
- [ ] 4.4 Tag `v2.0.0`
```

- [ ] **Step 7: Validate, check, commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec validate unified-release --type change --strict --no-interactive
bun run check:specs
grep -rnP '[\x{0400}-\x{04FF}]' openspec/changes/unified-release || echo "no cyrillic"
git add openspec/changes/unified-release
git commit -m "docs(openspec): propose unified-release (one version, one tag, four workflows)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013RKSL2xGHE1y3njSG8oymq"
```

Expected: `Change 'unified-release' is valid`, baseline specs pass.

---

### Task 5: Reconcile the design spec, validate everything, push

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-v2-contract-first-refactor-design.md` (section 3, C4)

**Interfaces:**
- Consumes: the engine-pin derivation rule from Task 4 D1.
- Produces: a spec whose C4 matches the `unified-release` proposal.

- [ ] **Step 1: Amend C4 in the design spec**

Find the paragraph in section 3, C4, that begins `CLI and engine share `package.json#version`` and append this paragraph directly after it:

```markdown
The Engine pin is derived at publish time, never committed: a stable CLI resolves the Engine of its own version, a beta resolves the Engine beta of its own version, and a per-merge CLI alpha resolves the newest stable Engine unless the dispatcher names an Engine pre-release. `package.json#keshaEngine.version` is removed and `check:versions` refuses any pin field on `main`. This is what keeps "Engine alphas are published deliberately" (`openspec/specs/release-channels/spec.md:132`) true under one version: a CLI alpha must not cost an Engine build.
```

- [ ] **Step 2: Validate all changes and all specs together**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
openspec validate --changes --strict --no-interactive
bun run check:specs
ls openspec/changes | grep -vE '^archive$'
```

Expected: every change valid (the five pre-existing ones and the four new); baseline specs pass; the listing shows `build-profiles core-api-v2 protocol-v4 unified-release` among the changes.

- [ ] **Step 3: Preflight and push**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/refactor-v2-design
git add docs/superpowers/specs/2026-09-05-v2-contract-first-refactor-design.md
git commit -m "docs(specs): derive the Engine pin at publish time under one version

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013RKSL2xGHE1y3njSG8oymq"
just preflight
git push
```

Expected: preflight green (TS gate; Rust gate skipped, no `rust/` changes); the push updates PR #1153. Then confirm CI on the new head SHA with `gh run list --commit $(git rev-parse HEAD)` (full SHA, never abbreviated) and record in a PR comment whether Greptile reported.
