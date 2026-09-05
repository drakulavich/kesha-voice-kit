## ADDED Requirements

### Requirement: `transcribe(path, opts?)` returns a `TranscribeResult`

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

> *Technical Note — `transcribe` is `src/lib.ts:44-53` today, returning `Promise<string>`; `transcribeWithTimestamps` (`src/lib.ts:55`) and the alias `transcribeWithSegments` (`src/lib.ts:74`) are removed by this change.*

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

> *Technical Note — Wraps `installEngine` in `src/engine-install.ts` (today reached through `downloadEngine` at `src/lib.ts:11` and `downloadTts` at `src/lib.ts:37`). The platform pre-check stays where it is, per the engine-contract rule that platform pre-checks precede schema validation (protocol-v4): with no Engine on disk there is no describe document to validate against, so the platform pre-check reports `E_UNSUPPORTED_PLATFORM` (today it throws a bare `Error` at `src/cli/install.ts:228-233`; v4 assigns the code) rather than `E_INVALID_ARG`.*

### Requirement: `capabilities()` exposes the Engine's schema

The Core API SHALL expose `capabilities()`, resolving to the describe document of the installed Engine, so Sona can feature-gate her agent without spawning the Engine herself.

#### Scenario: Sona checks for diarization before offering it

- GIVEN a darwin-arm64 Engine is installed
- WHEN Sona calls `await capabilities()`
- THEN `features` contains `transcribe.diarize` and `profile` is `darwin`

#### Scenario: No Engine installed

- GIVEN the Engine binary is absent
- WHEN Sona calls `await capabilities()`
- THEN the promise rejects with a `KeshaError` whose `code` is `E_ENGINE_SPAWN` and whose `hint` names `kesha install`

> *Technical Note — Reads through the cached describe document in `src/engine/describe.ts` (protocol-v4 change).*

### Requirement: Every rejection is a `KeshaError`

Every promise the Core API returns SHALL reject with a `KeshaError` carrying `code` (a published Error code), `hint` when a remedy is known, and `exitCode` and `stderr` whenever an Engine subprocess ran or a pre-flight assigned an Exit code; no Core API function SHALL reject with a bare `Error`.

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

#### Scenario: Exit codes survive the rename

- GIVEN `say` is called with empty `text`
- WHEN the promise rejects
- THEN the rejection is a `KeshaError` with `code` `E_TEXT_EMPTY` and `exitCode` `2`

> *Technical Note — `KeshaError` in `src/engine/events.ts`; replaces `SayError` (`src/synth.ts:103-113`) and the `Error("File not found: ...")` at `src/lib.ts:49`.*

## MODIFIED Requirements

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

> *Technical Note — `say` in `src/synth.ts:157`. `MAX_TEXT_CHARS = 5000` at
> `src/synth.ts:25`. `E_TEXT_EMPTY` exit code 2 at `src/synth.ts:160`;
> `E_TEXT_TOO_LONG` exit code 5 at `src/synth.ts:163-169`. Engine-not-installed
> throws `E_ENGINE_SPAWN` with exit code 1 at `src/synth.ts:172-178`; its
> message embeds `installHint("--tts")` (`src/install-hint.ts:9`) — `kesha init
> --tts` when `process.stderr.isTTY`, `kesha install --tts` otherwise. The
> `noExpandAbbrev` capability check is `applyNoExpandAbbrev` at
> `src/synth.ts:69-85`, reached from `buildSayArgs` at `src/synth.ts:98` — today;
> under v4 the drop is schema-driven in `src/engine/describe.ts`.
> `KeshaError` in `src/engine/events.ts` carries `exitCode` and `stderr` exactly
> as `SayError` did (`src/synth.ts:103-113`).*

### Requirement: Exported types cover the full public surface

The Core API SHALL export the following TypeScript types: `TranscribeResult`, `TranscribeOptions`, `TranscribeErrorRecord`, `TranscribeJsonOutput`, `TranscriptionSegment`, `WordTiming`, `SayOptions`, `InstallOptions`, `EngineDescription`, `VadMode`, and the class `KeshaError`. These SHALL NOT change shape without a major version bump.

#### Scenario: Sona types her wrapper function

- WHEN Sona writes `import type { SayOptions, InstallOptions } from "@drakulavich/kesha-voice-kit/core"`
- THEN the TypeScript compiler resolves both types without error

#### Scenario: A removed type is imported

- WHEN Sona writes `import type { TranscriptionOutput } from "@drakulavich/kesha-voice-kit/core"`
- THEN the TypeScript compiler reports that the module has no such export

> *Technical Note — Today's list at `src/lib.ts:9-31`; `TranscriptionOutput` and `SayError` leave, `WordTiming` (already exported at `src/lib.ts:10`), `InstallOptions`, `EngineDescription` and `KeshaError` join.*

### Requirement: Never-auto-download — all functions throw when prerequisites are missing

No Core API function SHALL silently download the Engine or models. When a
prerequisite is absent, the function SHALL reject with a `KeshaError` whose
`hint` names the `kesha install` command needed to fix the situation.

#### Scenario: Transcribing without the Engine installed

- GIVEN the Engine binary has never been downloaded
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the promise rejects with a `KeshaError` carrying an actionable setup hint —
  `kesha init` on an interactive TTY, `kesha install` when stderr is piped

#### Scenario: Transcribing with the Engine installed downloads nothing

- GIVEN the Engine and ASR models are installed and `note.ogg` exists
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the call resolves without contacting GitHub Releases or HuggingFace

> *Technical Note — the CLI's Engine-presence check in `src/engine/spawn.ts` gates
> every Engine-dependent call; it replaces `isEngineInstalled()` (`src/engine.ts:86`)
> called from `preflightTranscribeWithSegments` (`src/transcribe.ts:42`), whose
> `bun add -g` + `installHint()` block at `src/transcribe.ts:46-51` becomes the
> `hint` carried by `KeshaError`. `installHint()` (`src/install-hint.ts:9`) yields
> `kesha init` on a TTY, `kesha install` otherwise.*

## REMOVED Requirements

### Requirement: `transcribe(path, opts?)` returns the transcript text

**Reason**: the return type changes from `Promise<string>` to `Promise<TranscribeResult>`, which is a different contract rather than a refinement of the same one. **Migration**: `await transcribe(p)` becomes `(await transcribe(p)).text`; the requirement is replaced by "`transcribe(path, opts?)` returns a `TranscribeResult`".

### Requirement: `transcribeWithTimestamps(path, opts?)` returns text and segments

**Reason**: `transcribe` returns the structured result; `opts.timestamps` selects segments. **Migration**: `transcribeWithTimestamps(p, o)` becomes `transcribe(p, { ...o, timestamps: true })`; `transcribeWithSegments` likewise.

### Requirement: `downloadModel` / `downloadEngine` installs the Engine binary

**Reason**: the name said "model" and installed the Engine; replaced by `install()`. **Migration**: `downloadModel()` becomes `install()`; `downloadCoreML()` likewise.

### Requirement: `downloadTts(noCache?, langs?)` installs TTS models

**Reason**: folded into `install({ tts, noCache })`. **Migration**: `downloadTts(false, ["en", "ru"])` becomes `install({ engine: false, tts: ["en", "ru"] })`.
