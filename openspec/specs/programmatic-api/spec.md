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

### Requirement: `transcribe(path, opts?)` returns the transcript text

`transcribe` SHALL accept an audio file path and an optional `TranscribeOptions`
object. It SHALL:
1. Throw `Error("File not found: <path>")` when the file does not exist (checked
   before spawning the Engine).
2. Spawn the Engine with `silent: true` (no progress output to stderr).
3. Return a `Promise<string>` resolving to the transcript text.
4. Throw when the Engine fails (non-zero exit).

#### Scenario: Sona transcribes a voice note

- GIVEN the Engine and ASR models are installed and `note.ogg` exists
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the function resolves to the transcript string
- AND no output appears on stderr

#### Scenario: File does not exist

- WHEN Sona calls `await transcribe("ghost.ogg")`
- THEN the promise rejects with an Error whose message contains `"File not found: ghost.ogg"`

> *Technical Note — `transcribe` in `src/lib.ts:44`. `existsSync` check at
> `src/lib.ts:46`. Calls `internalTranscribe` with `{ ...options, silent: true }`.
> The `silent` flag suppresses the Engine's stderr progress output.*

### Requirement: `transcribeWithTimestamps(path, opts?)` returns text and segments

`transcribeWithTimestamps` SHALL return a `Promise<TranscriptionOutput>` with
`text` (string) and `segments` (array of `TranscriptionSegment`). Each segment
has `start` (number, seconds), `end` (number, seconds), `text` (string), and
optionally `speaker` (number, when diarization was requested). It SHALL throw
`Error("File not found: <path>")` when the file does not exist.

`transcribeWithSegments` is a deprecated alias for `transcribeWithTimestamps`
introduced in v1.9.0. Both names MUST remain importable; no removal is
scheduled before the next major version.

#### Scenario: Sona needs word-level timestamps for a subtitle generator

- GIVEN `lecture.mp3` exists and the Engine supports `transcribe.segments`
- WHEN Sona calls `await transcribeWithTimestamps("lecture.mp3")`
- THEN the result has a non-empty `segments` array
- AND each element has numeric `start`, `end`, and a `text` string

#### Scenario: Deprecated alias still works

- WHEN Sona imports `transcribeWithSegments` from `"@drakulavich/kesha-voice-kit/core"`
- THEN the import succeeds
- AND calling it with a valid path returns the same result as `transcribeWithTimestamps`

#### Scenario: File not found throws actionable error

- WHEN Sona calls `await transcribeWithTimestamps("missing.mp3")`
- THEN the promise rejects with `Error("File not found: missing.mp3")`

> *Technical Note — `transcribeWithTimestamps` in `src/lib.ts:55`. Deprecated
> alias `transcribeWithSegments` at `src/lib.ts:75`. `TranscriptionSegment`
> type in `src/engine.ts:28`.*

### Requirement: `say(opts)` synthesizes speech and returns audio bytes

`say` SHALL accept a `SayOptions` object and return a `Promise<Uint8Array>`
containing the raw audio bytes (WAV IEEE-float mono by default, or the format
specified by `opts.format`). When `opts.out` is set, the Engine writes to the
file and the returned `Uint8Array` is empty.

`say` SHALL throw `SayError` — a subclass of `Error` carrying `exitCode`,
`stderr`, and `code` — on any failure. Specific pre-flight failures:
- `text` is empty or missing → `SayError` with `exitCode: 2` and
  `code: "E_TEXT_EMPTY"`.
- `text` exceeds `MAX_TEXT_CHARS` (5000 Unicode code points) → `SayError`
  with `exitCode: 5` and `code: "E_TEXT_TOO_LONG"`.
- Engine not installed → `SayError` with `exitCode: 1` and
  `code: "E_ENGINE_SPAWN"` (the `TS_NATIVE_CODES.ENGINE_SPAWN` value).

When `opts.noExpandAbbrev` is set and the Engine does not advertise
`tts.ru_acronym_expansion` or `tts.en_acronym_expansion`, the flag is silently
dropped and a `log.warn` message is emitted (not a thrown error).

#### Scenario: Sona synthesizes a Russian reply

- GIVEN the Russian Vosk-TTS model is installed
- WHEN Sona calls `await say({ text: "Привет мир", voice: "ru-vosk-m02" })`
- THEN the result is a non-empty `Uint8Array` of WAV audio bytes

#### Scenario: Empty text throws immediately

- WHEN Sona calls `await say({ text: "" })`
- THEN the promise rejects with a `SayError`
- AND `err.exitCode === 2`
- AND `err.code === "E_TEXT_EMPTY"`

#### Scenario: Text too long throws immediately

- WHEN Sona calls `await say({ text: "x".repeat(5001) })`
- THEN the promise rejects with a `SayError`
- AND `err.exitCode === 5`
- AND `err.code === "E_TEXT_TOO_LONG"`

#### Scenario: Engine not installed throws actionable error

- GIVEN `kesha install` has not been run
- WHEN Sona calls `await say({ text: "hello" })`
- THEN the promise rejects with a `SayError` (`err.code === "E_ENGINE_SPAWN"`,
  `err.exitCode === 1`)
- AND its message carries an actionable setup hint ending in `--tts` — the verb
  is `kesha init` on an interactive TTY and `kesha install` when stderr is piped

#### Scenario: Writing to a file

- WHEN Sona calls `await say({ text: "hello", out: "/tmp/hello.wav" })`
- THEN the file `/tmp/hello.wav` is written with WAV audio
- AND the returned `Uint8Array` is empty

> *Technical Note — `say` in `src/synth.ts:112`. `MAX_TEXT_CHARS = 5000` at
> `src/synth.ts:22`. `SayError` at `src/synth.ts:96` carries `exitCode`,
> `stderr`, `code`. `E_TEXT_EMPTY` exit code 2 at `src/synth.ts:115`;
> `E_TEXT_TOO_LONG` exit code 5 at `src/synth.ts:118`. Engine-not-installed
> throws `TS_NATIVE_CODES.ENGINE_SPAWN` (`"E_ENGINE_SPAWN"`) with exit code 1 at
> `src/synth.ts:127-134`; its message embeds `installHint("--tts")`
> (`src/install-hint.ts:9`) — `kesha init --tts` when `process.stderr.isTTY`,
> `kesha install --tts` otherwise. The `noExpandAbbrev`
> capability check is in `buildSayArgs` at `src/synth.ts:66`.*

### Requirement: `downloadModel` / `downloadEngine` installs the Engine binary

The Core API SHALL expose `downloadModel` (primary export name) and
`downloadEngine` (the underlying function, also exported) to download and cache
the Engine binary. They are identical; `downloadModel` is the preferred
programmatic name. The deprecated `downloadCoreML` alias also resolves to the
same function.

#### Scenario: Sona installs the Engine from her setup script

- WHEN Sona calls `await downloadModel()`
- THEN the Engine binary is present at the default location
- AND subsequent `transcribe` calls succeed

> *Technical Note — `downloadEngine` imported from `src/engine-install.ts`
> and re-exported as `downloadModel` at `src/lib.ts:11`. `downloadCoreML`
> deprecated alias at `src/lib.ts:42`.*

### Requirement: `downloadTts(noCache?, langs?)` installs TTS models

`downloadTts` SHALL accept an optional `noCache` flag (default `false`) and an
optional `langs` array (default `["en"]`). It SHALL install TTS models for the
specified language codes by delegating to the Engine's `install` subcommand.
Unsupported-on-platform language codes are rejected by the Engine.

#### Scenario: Sona installs English and Russian TTS in one call

- WHEN Sona calls `await downloadTts(false, ["en", "ru"])`
- THEN TTS models for both languages are present in the Model cache
- AND subsequent `say({ text: "hello" })` and
  `say({ text: "привет", voice: "ru-vosk-m02" })` succeed

> *Technical Note — `downloadTts` at `src/lib.ts:37`. Delegates to
> `downloadEngine(noCache, undefined, { ttsLangs: langs })`.*

### Requirement: `toToon(results)` encodes a result array as TOON

`toToon` SHALL accept a `TranscribeResult[]` and return a TOON-encoded string
identical to what `kesha --toon` would produce. The string is losslessly
decodable via `@toon-format/toon`'s `decode()` back to the same array.

#### Scenario: Sona formats results for an LLM context window

- GIVEN `results` is an array of `TranscribeResult` objects from multiple files
- WHEN Sona calls `toToon(results)`
- THEN the returned string is 30–60% shorter than the JSON equivalent
- AND `decode(toToon(results))` equals the original `results` array

> *Technical Note — `toToon` re-exported as `formatToonOutput` from
> `src/toon.ts` at `src/lib.ts:19`.*

### Requirement: Exported types cover the full public surface

The Core API SHALL export the following TypeScript types: `TranscribeResult`,
`TranscribeOptions`, `TranscribeErrorRecord`, `TranscribeJsonOutput`,
`TranscriptionOutput`, `TranscriptionSegment`, `SayOptions`, `SayError`,
`VadMode`. These types SHALL not change shape without a major version bump.

#### Scenario: Sona types her wrapper function

- WHEN Sona writes `import type { SayOptions, SayError } from "@drakulavich/kesha-voice-kit/core"`
- THEN the TypeScript compiler resolves both types without error

> *Technical Note — `TranscribeResult`, `TranscribeErrorRecord`,
> `TranscribeJsonOutput` re-exported from `src/types.ts` at `src/lib.ts:26`.
> `TranscriptionOutput`, `TranscriptionSegment` re-exported from `src/engine.ts`
> at `src/lib.ts:10`. `TranscribeOptions` re-exported from `src/transcribe.ts`
> at `src/lib.ts:9`. `SayOptions`, `SayError` re-exported from `src/synth.ts`
> at `src/lib.ts:12`. `VadMode` exported via `src/transcribe.ts`.*

### Requirement: Never-auto-download — all functions throw when prerequisites are missing

No Core API function SHALL silently download the Engine or models. When a
prerequisite is absent, the function SHALL throw with an actionable error
message naming the `kesha install` command needed to fix the situation.

#### Scenario: Transcribing without the Engine installed

- GIVEN the Engine binary has never been downloaded
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the promise rejects with an error containing `kesha install`

> *Technical Note — `isEngineInstalled()` in `src/engine.ts:50` gates
> Engine-dependent calls. `preflightTranscribeWithSegments` in
> `src/transcribe.ts:32` checks `isEngineInstalled()` and throws with a
> `bun add -g` + `kesha install` hint when false.*

## Open Issues

- `say()` always passes `text` via stdin to the Engine subprocess; the
  `SayOptions.text` field is required for programmatic callers because `say()`
  does not forward the host process's stdin. This asymmetry from the CLI is not
  surfaced in the type; it is documented only in the JSDoc comment.
- `downloadTts` does not expose a progress callback; callers cannot observe
  download progress except via stderr parsing.
