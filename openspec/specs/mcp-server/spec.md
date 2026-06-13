# MCP Server Specification

## Purpose

`kesha mcp` starts a Model Context Protocol stdio server that exposes Kesha
Voice Kit's transcription and TTS capabilities to LLM clients. Sona embeds it
in agent pipelines to transcribe audio files, synthesize speech, and discover
available voices — all without shelling out to `kesha` herself. The server
follows the MCP stdio transport: the client configures
`{ command: "kesha", args: ["mcp"] }` and communicates via JSON-RPC on
stdin/stdout.

## Non-Goals

- The MCP server is a thin adapter over the same CLI and Engine paths. It does
  not implement its own audio codec or TTS engine.
- No authentication or multi-user isolation: the server runs as the invoking
  user and inherits the same Model cache and Engine binary.
- No streaming transcription or partial results.
- Remote or HTTP MCP transports are not provided; only stdio.

## Requirements

### Requirement: `kesha mcp` starts a named MCP stdio server

The CLI SHALL start an MCP server named `kesha-voice-kit` over stdio and block
until the client disconnects. The server version matches the CLI package
version. At server start, audio files older than 24 hours in the MCP audio
directory are swept.

The server exposes four tools (`transcribe_audio`, `synthesize_speech`,
`list_voices`, `list_languages`) and one resource template
(`kesha-audio://{file}`).

#### Scenario: Sona configures kesha mcp in her agent

- GIVEN Sona adds `{ command: "kesha", args: ["mcp"] }` to her MCP client
- WHEN the client initializes the connection
- THEN the server announces itself as `kesha-voice-kit`
- AND the four tools appear in the tools list
- AND the kesha-audio resource template appears in the resources list
- AND the server remains running until the client closes the connection

> *Technical Note — `mcpCommand` in `src/cli/mcp.ts:5` creates the server via
> `createKeshaMcpServer()` (`src/mcp/server.ts:6`) and connects a
> `StdioServerTransport`. `sweepOldAudio()` runs at server creation
> (`src/mcp/server.ts:7`). Server name is `"kesha-voice-kit"` at
> `src/mcp/server.ts:8`.*

### Requirement: `transcribe_audio` transcribes a local audio file

The `transcribe_audio` tool SHALL accept a `path` (string, required) and
`timestamps` (boolean, optional). When the file does not exist, it SHALL return
`isError: true` without throwing. When transcription succeeds, the tool returns
`structuredContent` with `text` (string) and `segments` (array). Without
`timestamps`, `segments` is an empty array. With `timestamps`, each segment
carries numeric `start`, `end`, and `text`; an optional `speaker` number is
included when diarization was requested by the engine. The tool's
`annotations.readOnlyHint` is `true`.

#### Scenario: Sona transcribes a meeting recording

- GIVEN `meeting.ogg` exists and the Engine is installed
- WHEN Sona calls `transcribe_audio` with `{ path: "/abs/meeting.ogg" }`
- THEN the response `structuredContent.text` contains the transcript
- AND `structuredContent.segments` is an empty array
- AND `isError` is absent (success path)

#### Scenario: Sona requests segment timestamps

- WHEN Sona calls `transcribe_audio` with
  `{ path: "/abs/meeting.ogg", timestamps: true }`
- THEN `structuredContent.segments` is a non-empty array of objects each
  containing numeric `start`, `end`, and `text` fields

#### Scenario: File does not exist

- WHEN Sona calls `transcribe_audio` with `{ path: "/abs/missing.ogg" }`
- THEN the response has `isError: true`
- AND the `content[0].text` names the missing file

> *Technical Note — `transcribe_audio` is registered in `src/mcp/tools.ts:87`.
> Missing-file check at `src/mcp/tools.ts:113` uses `existsSync` before
> spawning the engine. Segment shape at `src/mcp/tools.ts:96-104`.
> `readOnlyHint: true` at `src/mcp/tools.ts:107`.*

### Requirement: `synthesize_speech` produces an audio file and returns a resource link

The `synthesize_speech` tool SHALL accept `text` (string, min length 1),
`voice` (string, optional — auto-routes when omitted, defaulting to
`en-am_michael` for English and `ru-vosk-m02` for Russian), `rate` (number,
optional, 0.5–2.0), and `format` (`"wav"` | `"ogg-opus"` | `"flac"`, optional,
default `"wav"`).

The tool SHALL:
1. Validate `rate` and return `isError: true` when it is outside `[0.5, 2.0]`.
2. Synthesize audio via the Engine and write it to a UUID-named file in
   `<tmpdir>/kesha-mcp/` with permissions `0600`.
3. Return a `resource_link` content item with URI `kesha-audio://<filename>`
   and a text summary of the synthesis.
4. Return `structuredContent` with `uri`, `path`, `format`, `voice`, and
   `bytes`.

`annotations.readOnlyHint` is `false`.

#### Scenario: Sona synthesizes an English announcement

- GIVEN TTS models are installed
- WHEN Sona calls `synthesize_speech` with `{ text: "Meeting starts now." }`
- THEN the response contains a `resource_link` item with a `kesha-audio://`
  URI
- AND `structuredContent.bytes` is greater than zero
- AND the file at `structuredContent.path` exists with permissions `0600`

#### Scenario: Rate out of range

- WHEN Sona calls `synthesize_speech` with `{ text: "hello", rate: 3.0 }`
- THEN the response has `isError: true`
- AND `content[0].text` mentions that `3` is out of range `(0.5-2.0)`

#### Scenario: Voice omitted — auto-route applies

- WHEN Sona calls `synthesize_speech` with `{ text: "Hello" }` and no `voice`
- THEN `structuredContent.voice` is `"(auto)"`
- AND synthesis succeeds using the Default voice

> *Technical Note — `synthesize_speech` registered at `src/mcp/tools.ts:35`.
> Rate validation at `src/mcp/tools.ts:61`. `allocAudioPath` in
> `src/mcp/audio-output.ts:25` creates `<tmpdir>/kesha-mcp/` with mode
> `0o700` and names the file `<uuid>.<ext>`. `chmodSync(outPath, 0o600)` at
> `src/mcp/tools.ts:69`. Resolved voice shows `"(auto)"` when `voice` was
> omitted (`src/mcp/tools.ts:73`).*

### Requirement: `list_voices` returns installed voice metadata

The `list_voices` tool SHALL invoke the Engine's `say --list-voices` and return
`structuredContent.voices` — an array of objects each containing `voiceId`,
`modelId` (`"kokoro"` | `"vosk"` | `"avspeech"` | `"unknown"`), `modelName`,
`languageCode`, `languageName`, and `gender` (`"male"` | `"female"` | `null`).
`annotations.readOnlyHint` is `true`.

#### Scenario: Sona lists voices to pick one for Russian

- GIVEN the Russian Vosk-TTS model is installed
- WHEN Sona calls `list_voices`
- THEN `structuredContent.voices` includes an entry with `voiceId: "ru-vosk-m02"`,
  `modelId: "vosk"`, `languageCode: "ru"`, and `gender: "male"`

#### Scenario: Engine fails to list voices

- GIVEN the Engine is not installed
- WHEN Sona calls `list_voices`
- THEN the response has `isError: true`
- AND `content[0].text` begins with `list_voices failed:`

> *Technical Note — `list_voices` registered at `src/mcp/tools.ts:135`.
> `listVoices()` in `src/mcp/voices.ts:110` spawns `kesha-engine say
> --list-voices`. `parseVoiceInfo` in `src/mcp/voices.ts:31` derives model,
> language, and gender from the Voice id prefix.*

### Requirement: `list_languages` returns aggregated language counts

The `list_languages` tool SHALL derive its data from `list_voices` and return
`structuredContent.languages` — an array sorted by `languageCode`, each entry
carrying `languageCode`, `languageName`, and `voiceCount`.

#### Scenario: Sona checks which languages are available

- GIVEN English (Kokoro) and Russian (Vosk) voices are installed
- WHEN Sona calls `list_languages`
- THEN the result contains entries for `"en-US"` (or `"en-GB"`) and `"ru"`
- AND each entry's `voiceCount` equals the number of installed voices for that
  language code

> *Technical Note — `list_languages` registered at `src/mcp/tools.ts:168`.
> `aggregateLanguages` in `src/mcp/voices.ts:126` groups by `languageCode` and
> sorts with `localeCompare`.*

### Requirement: `kesha-audio://{file}` resource returns base64-encoded audio

The resource template `kesha-audio://{file}` SHALL read the named file from the
MCP audio directory and return it as a base64-encoded blob with the correct
MIME type (`audio/wav`, `audio/ogg`, or `audio/flac`). Path traversal SHALL be
rejected by taking only the `basename` of the supplied `file` parameter.
Accessing a file that no longer exists (e.g. swept after 24 hours) SHALL throw
an error naming the file.

#### Scenario: Sona reads back synthesized audio

- GIVEN a previous `synthesize_speech` call returned URI `kesha-audio://abc.wav`
- WHEN Sona calls `resources/read` on that URI
- THEN the response contains a blob with `mimeType: "audio/wav"`
- AND the blob decodes to the same bytes as the file at the path

#### Scenario: Path traversal attempt rejected

- WHEN Sona calls `resources/read` on `kesha-audio://../../../etc/passwd`
- THEN the request looks up only `passwd` (basename) in the MCP audio directory
- AND if that file does not exist, an error is returned

#### Scenario: Swept file access

- GIVEN `kesha-audio://old.wav` was produced more than 24 hours ago and swept
- WHEN Sona attempts `resources/read kesha-audio://old.wav`
- THEN an error is returned stating the file is not found or already swept

> *Technical Note — resource handler at `src/mcp/tools.ts:18`. Basename
> sandbox: `basename(String(file))` at `src/mcp/tools.ts:23`. MIME selection
> by `mimeForExt` at `src/mcp/tools.ts:11`. `sweepOldAudio` in
> `src/mcp/audio-output.ts:30` deletes files with `mtimeMs < Date.now() - 24h`
> (`MAX_AGE_MS = 24 * 60 * 60 * 1000` at `src/mcp/audio-output.ts:7`).
> Audio directory: `join(tmpdir(), "kesha-mcp")` at
> `src/mcp/audio-output.ts:9`.*

### Requirement: Old MCP audio files are swept at server start

At every `kesha mcp` startup the server SHALL delete files in the MCP audio
directory whose modification time is more than 24 hours in the past, on a
best-effort basis (errors for individual files are silently ignored to handle
races and permission edge cases).

#### Scenario: Stale files cleaned at startup

- GIVEN `<tmpdir>/kesha-mcp/` contains files from 25 hours ago
- WHEN `kesha mcp` starts
- THEN those files are deleted before the first tool call is handled

#### Scenario: MCP directory does not yet exist

- GIVEN the MCP audio directory has never been created
- WHEN `kesha mcp` starts
- THEN `sweepOldAudio` returns without error (directory absence is silently
  ignored)

> *Technical Note — `sweepOldAudio()` called in `createKeshaMcpServer()`
> (`src/mcp/server.ts:7`). The sweep reads the directory with `readdirSync`;
> if the directory does not exist, the `catch` at `src/mcp/audio-output.ts:36`
> silently returns. Individual file errors are caught per-file at
> `src/mcp/audio-output.ts:43`.*

## Open Issues

- `synthesize_speech` returns `voice: "(auto)"` in `structuredContent` when no
  voice is given, making it impossible for the caller to know which voice was
  actually used; the engine could return the resolved Voice id in a future
  protocol revision.
- `transcribe_audio` does not expose a `lang` hint parameter; callers cannot
  influence language detection or trigger the expected-language mismatch warning
  via MCP.
