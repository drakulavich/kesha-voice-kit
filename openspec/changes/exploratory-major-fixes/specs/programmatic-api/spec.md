## MODIFIED Requirements

### Requirement: `transcribe(path, opts?)` returns the transcript text

`transcribe` SHALL accept an audio file path and an optional `TranscribeOptions`
object. It SHALL:
1. Throw `Error("File not found: <path>")` when the file does not exist (checked
   before spawning the Engine).
2. Throw a `KeshaError` whose `code` is `E_INVALID_ARG` and whose message
   contains `is a directory (expected an audio file)` when the path is a
   directory (checked before spawning the Engine) — the same code the CLI
   reports for that input, never the Engine's `E_BAD_AUDIO`.
3. Not surface the Engine's progress output on the caller's stderr.
4. Return a `Promise<string>` resolving to the transcript text.
5. Throw when the Engine fails (non-zero exit).

#### Scenario: Sona transcribes a voice note

- GIVEN the Engine and ASR models are installed and `note.ogg` exists
- WHEN Sona calls `await transcribe("note.ogg")`
- THEN the function resolves to the transcript string
- AND no Engine progress output appears on the caller's stderr

#### Scenario: File does not exist

- WHEN Sona calls `await transcribe("ghost.ogg")`
- THEN the promise rejects with an Error whose message contains `"File not found: ghost.ogg"`

#### Scenario: Path is a directory

- WHEN Sona calls `await transcribe("recordings/")` and `recordings` is a directory
- THEN the promise rejects with a `KeshaError` whose `code` is `E_INVALID_ARG`
- AND no Engine is spawned

> *Technical Note — `src/lib.ts::transcribe` runs `assertAudioFileArgument`
> (the `existsSync` check, then `src/transcribe.ts::isDirectoryPath`, the
> helper the CLI's `src/cli/main.ts` uses for the same refusal) before it
> delegates. The Engine never writes to the caller's stderr itself because
> `src/engine.ts::runEngine` spawns it with `stdio: ["ignore", "pipe",
> "pipe"]` — that stderr is read by the CLI and parsed as protocol 4 events,
> and travels inside the thrown Error on failure.*

### Requirement: `transcribeWithTimestamps(path, opts?)` returns text and segments

`transcribeWithTimestamps` SHALL return a `Promise<TranscriptionOutput>` with
`text` (string) and `segments` (array of `TranscriptionSegment`). Each segment
has `start` (number, seconds), `end` (number, seconds), `text` (string), and
optionally `speaker` (number, when diarization was requested). It SHALL throw
`Error("File not found: <path>")` when the file does not exist, and a
`KeshaError` whose `code` is `E_INVALID_ARG` when the path is a directory,
both before spawning the Engine.

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

#### Scenario: Path is a directory

- WHEN Sona calls `await transcribeWithTimestamps("recordings/")` and `recordings` is a directory
- THEN the promise rejects with a `KeshaError` whose `code` is `E_INVALID_ARG`
- AND no Engine is spawned

> *Technical Note — `src/lib.ts::transcribeWithTimestamps`, with the deprecated
> alias `src/lib.ts::transcribeWithSegments`; both share
> `src/lib.ts::assertAudioFileArgument` with `transcribe`. The
> `TranscriptionSegment` type is declared in `src/engine.ts::TranscriptionSegment`.*
