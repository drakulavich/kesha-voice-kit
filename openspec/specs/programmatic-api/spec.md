# Programmatic API Specification

## Purpose

`@drakulavich/kesha-voice-kit/core` is the programmatic interface for embedding
Kesha Voice Kit in Node.js/Bun applications and agent frameworks without
invoking the CLI directly. Sona uses it to transcribe audio, synthesize speech,
and install models inside her agent code. The Core API is a thin TypeScript
wrapper that spawns the Engine as a subprocess — the same Engine the CLI uses —
so behavior is identical to the CLI commands.

## Non-Goals

- The Core API does not provide streaming transcription; results are returned
  when the Engine subprocess exits.
- No built-in retry logic; callers handle transient failures.
- The Core API never downloads the Engine or models automatically
  (Never-auto-download rule); functions throw actionable errors when anything
  is missing.
- The CLI's output-format layer (`--json`, `--toon`, `--format`) is separate
  from the Core API; programmatic callers receive typed objects, not formatted
  strings (except via `toToon`).
## Requirements
### Requirement: Package exports map exposes `./core` as the programmatic entry point

The package SHALL export the programmatic API at the `"./core"` path, mapping
to `./src/lib.ts`. The default export (`"."`) maps to `./src/cli.ts` and is the
CLI entry; importing from `"."` does not give programmatic access to the Core
API.

#### Scenario: Sona imports the Core API

- WHEN Sona writes `import { transcribe } from "@drakulavich/kesha-voice-kit/core"`
- THEN the import resolves to `src/lib.ts`
- AND she receives the `transcribe` function, not the CLI runner

> *Technical Note — `package.json#exports`: `"./core": "./src/lib.ts"`,
> `".": "./src/cli.ts"`.*

### Requirement: `say(opts)` synthesizes speech and returns audio bytes

`say` SHALL accept a `SayOptions` object and return a `Promise<Uint8Array>`
containing the raw audio bytes (WAV IEEE-float mono by default, or the format
specified by `opts.format`). When `opts.out` is set, the Engine writes to the
file and the returned `Uint8Array` is empty.

`say` SHALL throw `KeshaError` — a subclass of `Error` carrying `exitCode`,
`stderr`, and `code` — on any failure. Specific pre-flight failures:
- `text` is empty or missing → `KeshaError` with `exitCode: 2` and
  `code: "E_TEXT_EMPTY"`.
- `text` exceeds `MAX_TEXT_CHARS` (5000 Unicode code points) → `KeshaError`
  with `exitCode: 5` and `code: "E_TEXT_TOO_LONG"`.
- `text` contains a NUL byte → `KeshaError` with `exitCode: 2` and
  `code: "E_INVALID_ARG"`.
- Engine not installed → `KeshaError` with `exitCode: 1` and
  `code: "E_ENGINE_SPAWN"`.

When `opts.noExpandAbbrev` is set and the Engine does not advertise
`tts.ru_acronym_expansion` or `tts.en_acronym_expansion`, the flag is dropped and
one `warn` event is rendered (not a thrown error), per the `whenUngated: drop`
rule of the `describe` schema (engine-contract, protocol-v4).

#### Scenario: Sona synthesizes a Russian reply

- GIVEN the Russian Vosk-TTS model is installed
- WHEN Sona calls `await say({ text: "Привет мир", voice: "ru-vosk-m02" })`
- THEN the result is a non-empty `Uint8Array` of WAV audio bytes

#### Scenario: Empty text throws immediately

- WHEN Sona calls `await say({ text: "" })`
- THEN the promise rejects with a `KeshaError`
- AND `err.exitCode === 2`
- AND `err.code === "E_TEXT_EMPTY"`

#### Scenario: Text too long throws immediately

- WHEN Sona calls `await say({ text: "x".repeat(5001) })`
- THEN the promise rejects with a `KeshaError`
- AND `err.exitCode === 5`
- AND `err.code === "E_TEXT_TOO_LONG"`

#### Scenario: Engine not installed throws actionable error

- GIVEN `kesha install` has not been run
- WHEN Sona calls `await say({ text: "hello" })`
- THEN the promise rejects with a `KeshaError` (`err.code === "E_ENGINE_SPAWN"`,
  `err.exitCode === 1`)
- AND its message carries an actionable setup hint ending in `--tts` — the verb
  is `kesha init` on an interactive TTY and `kesha install` when stderr is piped

#### Scenario: Writing to a file

- WHEN Sona calls `await say({ text: "hello", out: "/tmp/hello.wav" })`
- THEN the file `/tmp/hello.wav` is written with WAV audio
- AND the returned `Uint8Array` is empty

> *Technical Note — `say` in `src/synth.ts`, wrapped by `src/lib.ts::say`.
> `MAX_TEXT_CHARS = 5000`; the text pre-flight is `validateSayText`, which the
> CLI runs too. Engine-not-installed throws `E_ENGINE_SPAWN` with exit code 1;
> its message embeds `installHint("--tts")` (`src/install-hint.ts`) — `kesha init
> --tts` when `process.stderr.isTTY`, `kesha install --tts` otherwise — and it
> carries no separate `hint`, because `kesha say` prints the same error and its
> output does not change. The `noExpandAbbrev` drop is schema-driven in
> `src/engine/describe.ts::validateArgv`.*

### Requirement: `toToon(results)` encodes a result array as TOON

`toToon` SHALL accept a `TranscribeResult[]` and return a TOON-encoded string
identical to what `kesha --toon` would produce. The string is losslessly
decodable via `@toon-format/toon`'s `decode()` back to the same array. An
optional second argument (`TranscribeErrorRecord[]`) SHALL switch the output to
the `{ results, errors }` envelope `kesha --toon --include-errors` prints.

#### Scenario: Sona formats results for an LLM context window

- GIVEN `results` is an array of `TranscribeResult` objects from multiple files
- WHEN Sona calls `toToon(results)`
- THEN the returned string is 30–60% shorter than the JSON equivalent
- AND `decode(toToon(results))` equals the original `results` array

> *Technical Note — `src/toon.ts::formatToonOutput` is re-exported under the
> public name `src/lib.ts::toToon`.*

### Requirement: Exported types cover the full public surface

The Core API SHALL export the following TypeScript types: `TranscribeResult`, `TranscribeOptions`, `TranscribeErrorRecord`, `TranscribeJsonOutput`, `TranscriptionSegment`, `WordTiming`, `SayOptions`, `InstallOptions`, `EngineDescription`, `VadMode`, and the class `KeshaError`. These SHALL NOT change shape without a major version bump.

#### Scenario: Sona types her wrapper function

- WHEN Sona writes `import type { SayOptions, InstallOptions } from "@drakulavich/kesha-voice-kit/core"`
- THEN the TypeScript compiler resolves both types without error

#### Scenario: A removed type is imported

- WHEN Sona writes `import type { TranscriptionOutput } from "@drakulavich/kesha-voice-kit/core"`
- THEN the TypeScript compiler reports that the module has no such export

> *Technical Note — `src/lib.ts`; `TranscriptionOutput` and `SayError` leave, `InstallOptions` and `EngineDescription` (an alias of `src/engine/describe.ts::DescribeDocument`) join. `hasErrorRecords`, the type guard for `TranscribeJsonOutput`, stays exported.*

### Requirement: Never-auto-download — all functions throw when prerequisites are missing

No Core API function other than `install` SHALL download the Engine or models.
When a prerequisite is absent, the function SHALL reject with a `KeshaError`
that names the `kesha install` command needed to fix the situation: in its
`hint` for `transcribe` and `capabilities`, in its message for `say`, as
`kesha say` prints it.

#### Scenario: Transcribing without the Engine installed

- GIVEN the Engine binary has never been downloaded
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_ENGINE_SPAWN`
  and whose `hint` names `kesha install`

#### Scenario: Transcribing with the Engine installed downloads nothing

- GIVEN the Engine and ASR models are installed and `note.ogg` exists
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the call resolves without contacting GitHub Releases or HuggingFace

> *Technical Note — the describe lookup in `src/engine.ts::getDescribe` and the
> spawn in `src/engine/spawn.ts::runEngineProcess` both throw `E_ENGINE_SPAWN`
> with `spawnHint()` — "run `kesha install`", or, when `KESHA_ENGINE_BIN` is set,
> a hint to fix that path. The CLI's own transcribe gate,
> `src/transcribe.ts::validateTranscribeRequest`, keeps its `bun add -g` +
> `installHint()` block; the Core API does not run it.*

### Requirement: `transcribe(path, opts?)` returns a `TranscribeResult`

`transcribe` SHALL accept an audio file path and an optional `TranscribeOptions` object and SHALL resolve to a `TranscribeResult` — the type one file produces under `kesha --json` — whose `file` is the path it was given, whose `text` is the transcript, whose `lang` is the language the CLI-side text detector names (empty when it names none above the confidence floor), and whose `segments` is present only when `opts.timestamps` or `opts.speakers` was set. It SHALL reject with `KeshaError` `E_INPUT_NOT_FOUND` before spawning the Engine when the file does not exist, and with `E_INVALID_ARG` when the path is a directory; it SHALL NOT surface Engine events on the caller's stderr, and SHALL reject with the Engine's Error code when the Engine fails.

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

#### Scenario: Path is a directory

- WHEN Sona calls `await transcribe("recordings/")` and `recordings` is a directory
- THEN the promise rejects with a `KeshaError` whose `code` is `E_INVALID_ARG`
- AND no Engine is spawned

> *Technical Note — `src/lib.ts::transcribe` runs `src/transcribe.ts::assertAudioFileArgument`, then `transcribeWithSegments`, then `src/language-routing.ts::detectTextLanguageFallback` and `routeLanguage`. The Engine's audio language ID and the macOS text detector stay CLI-only: each is another Engine spawn, and each warns on the caller's stderr when it fails. `transcribeWithTimestamps` and the alias `transcribeWithSegments` are removed by this change.*

### Requirement: `install(opts?)` is the one programmatic installer

The Core API SHALL expose `install(opts?)`, which performs what `kesha install` performs for the same options: `tts` (a list of language codes, `--tts <langs>`, default none), `vad` (`--vad`), `diarize` (`--diarize`), `noCache` (`--no-cache`), `backend` (`"coreml"` or `"onnx"`, `--coreml`/`--onnx`), `engineVersion` (`--engine-version`). With no options it installs the Engine and the ASR models. It SHALL make the refusals `kesha install` makes before any download, with the same Error codes, and SHALL be the only exported function that downloads anything.

#### Scenario: Sona installs the Engine and English TTS from her setup script

- WHEN Sona calls `await install({ tts: ["en"] })`
- THEN the Engine binary and the English TTS models are present in the Model cache
- AND subsequent `transcribe` and `say` calls succeed

#### Scenario: Diarize requested where it cannot be served

- GIVEN the platform is not darwin-arm64
- WHEN Sona calls `await install({ diarize: true })`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_UNSUPPORTED_PLATFORM`
- AND nothing was downloaded

#### Scenario: A malformed Engine version

- WHEN Sona calls `await install({ engineVersion: "latest" })`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_INVALID_ARG`
- AND nothing was downloaded

> *Technical Note — Wraps `installEngine` in `src/engine-install.ts`, after the refusals `src/cli/install.ts` makes: `resolveEngineVersionFlag`, `unavailableBackendRefusal`, and the TTS language check against the Engine's list or `installableTtsLangs()`. The platform pre-check stays where it is, per the engine-contract rule that platform pre-checks precede schema validation (protocol-v4): with no Engine on disk there is no describe document to validate against, so the platform pre-check reports `E_UNSUPPORTED_PLATFORM` (`assertPlatformCanInstall`) rather than `E_INVALID_ARG`. `--plan` has no counterpart: it installs nothing.*

### Requirement: `capabilities()` exposes the Engine's schema

The Core API SHALL expose `capabilities()`, resolving to the describe document of the installed Engine (`EngineDescription`), so Sona can feature-gate her agent without spawning the Engine herself. Changing the returned object SHALL NOT change what later calls see.

#### Scenario: Sona checks for diarization before offering it

- GIVEN a darwin-arm64 Engine is installed
- WHEN Sona calls `await capabilities()`
- THEN `features` contains `transcribe.diarize` and `profile` is `darwin`

#### Scenario: No Engine installed

- GIVEN the Engine binary is absent
- WHEN Sona calls `await capabilities()`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_ENGINE_SPAWN` and whose `hint` names `kesha install`

> *Technical Note — Reads through the describe document `src/engine.ts::getDescribe` caches per binary identity, and returns a `structuredClone` of it.*

### Requirement: Every rejection is a `KeshaError`

Every promise the Core API returns SHALL reject with a `KeshaError` carrying `code` (a published Error code), `hint` when a remedy is known, and `exitCode` and `stderr` whenever an Engine subprocess ran or a pre-flight assigned an Exit code; no Core API function SHALL reject with a bare `Error`. A failure nothing coded SHALL reject as `E_INTERNAL` carrying the original message.

#### Scenario: A successful call raises nothing

- GIVEN the Engine and ASR models are installed and `note.ogg` exists
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the promise resolves to a `TranscribeResult`
- AND the promise does not reject

#### Scenario: Engine failure surfaces its code

- GIVEN the ASR model is not installed
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the rejection is a `KeshaError` with `code` `E_MODEL_MISSING` and a `hint` naming `kesha install`

#### Scenario: A CLI-side failure uses the same type

- WHEN Sona calls `await transcribe("ghost.ogg")`
- THEN the rejection is a `KeshaError` with `code` `E_INPUT_NOT_FOUND`
- AND `message` contains `ghost.ogg`

#### Scenario: An uncoded failure is still coded

- GIVEN the Engine's model install exits non-zero without an error event
- WHEN Sona calls `await install()`
- THEN the rejection is a `KeshaError` with `code` `E_INTERNAL`
- AND `message` carries the exit status

#### Scenario: Exit codes survive the rename

- GIVEN `say` is called with empty `text`
- WHEN the promise rejects
- THEN the rejection is a `KeshaError` with `code` `E_TEXT_EMPTY` and `exitCode` `2`

> *Technical Note — `KeshaError` in `src/engine/events.ts`; `src/lib.ts` wraps each exported async function so a non-`KeshaError` rejection becomes `E_INTERNAL`, the one catch-all the Engine publishes with origin `both` (`tests/unit/capabilities-pact.test.ts`). `SayError` (`src/synth.ts`) is removed.*

## Open Issues

- `say()` always passes `text` via stdin to the Engine subprocess; the
  `SayOptions.text` field is required for programmatic callers because `say()`
  does not forward the host process's stdin. This asymmetry from the CLI is not
  surfaced in the type; it is documented only in the JSDoc comment.
- `install` does not expose a progress callback; callers cannot observe
  download progress except via stderr parsing.
