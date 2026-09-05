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

> *Technical Note — Wraps `installEngine` in `src/engine-install.ts` (today reached through `downloadEngine` at `src/lib.ts:11` and `downloadTts` at `src/lib.ts:37`).*

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

#### Scenario: A successful call raises nothing

- GIVEN the Engine and ASR models are installed and `note.ogg` exists
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the promise resolves to a `TranscribeResult`
- AND no `KeshaError` is constructed or thrown

#### Scenario: Engine failure surfaces its code

- GIVEN the ASR model is not installed
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the rejection is a `KeshaError` with `code` `E_MODEL_MISSING` and a `hint` naming `kesha install`

#### Scenario: A CLI-side failure uses the same type

- WHEN Sona calls `await transcribe("ghost.ogg")`
- THEN the rejection is a `KeshaError` with `code` `E_INPUT_NOT_FOUND`
- AND `message` contains `ghost.ogg`

> *Technical Note — `KeshaError` in `src/engine/events.ts`; replaces `SayError` (`src/synth.ts`) and the `Error("File not found: ...")` at `src/lib.ts:49`.*

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

> *Technical Note — `src/lib.ts:44-70` today; `transcribeWithTimestamps` (`src/lib.ts:55`) and the alias `transcribeWithSegments` (`src/lib.ts:74`) are removed by this change.*

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

**Reason**: `transcribe` returns the structured result; `opts.timestamps` selects segments. **Migration**: `transcribeWithTimestamps(p, o)` becomes `transcribe(p, { ...o, timestamps: true })`; `transcribeWithSegments` likewise.

### Requirement: `downloadModel` / `downloadEngine` installs the Engine binary

**Reason**: the name said "model" and installed the Engine; replaced by `install()`. **Migration**: `downloadModel()` becomes `install()`; `downloadCoreML()` likewise.

### Requirement: `downloadTts(noCache?, langs?)` installs TTS models

**Reason**: folded into `install({ tts, noCache })`. **Migration**: `downloadTts(false, ["en", "ru"])` becomes `install({ engine: false, tts: ["en", "ru"] })`.
