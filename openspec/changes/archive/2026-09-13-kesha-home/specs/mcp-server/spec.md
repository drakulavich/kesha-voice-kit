## MODIFIED Requirements

### Requirement: `synthesize_speech` produces an audio file and returns a resource link

The `synthesize_speech` tool SHALL accept `text` (string, min length 1),
`voice` (string, optional — auto-routes when omitted, defaulting to
`en-am_michael` for English and `ru-vosk-m02` for Russian), `rate` (number,
optional, 0.5–2.0), and `format` (`"wav"` | `"ogg-opus"` | `"flac"`, optional,
default `"wav"`).

The tool SHALL:
1. Validate `rate` and return `isError: true` when it is outside `[0.5, 2.0]`.
2. Synthesize audio via the Engine and write it to a UUID-named file in
   the MCP audio directory (`<tmpdir>/kesha-mcp/` by default, `<KESHA_HOME>/mcp-audio/`
   when `KESHA_HOME` is set; `state-directories`) with permissions `0600`.
3. Return a `resource_link` content item with URI `kesha-audio://<filename>`
   and a text summary of the synthesis.
4. Return `structuredContent` with `uri`, `path`, `format`, `voice`, and
   `bytes`. `voice` SHALL be the Voice id that actually synthesized the audio —
   the caller's when one was given, the auto-routed one otherwise — and SHALL be
   valid input to a follow-up call, never a placeholder.

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
- THEN the text's language is detected and routed to that language's default
  voice, exactly as `kesha say` routes it
- AND `structuredContent.voice` is that Voice id (`en-am_michael` here)

#### Scenario: The auto-routed voice is not installed

- GIVEN the detected language routes to a voice whose models are not installed
- WHEN Sona calls `synthesize_speech` with no `voice`
- THEN the call returns `isError: true` carrying the Engine's own message, the
  same failure `kesha say` gives — rather than silently speaking a voice the
  caller did not ask for

#### Scenario: Voice omitted and the language does not route

- GIVEN text-language detection is unavailable, or the detected language has no
  voice on this build
- WHEN Sona calls `synthesize_speech` with no `voice`
- THEN synthesis uses the Engine's default voice
- AND `structuredContent.voice` names that voice rather than a placeholder

> *Technical Note — `synthesize_speech` is registered by
> `src/mcp/tools.ts::registerTools`, which rejects a `rate` outside
> `(0.5-2.0)` and applies `chmodSync(outPath, 0o600)` once synthesis returns.
> `src/mcp/audio-output.ts::allocAudioPath` creates the MCP audio directory
> (`src/state-paths.ts::resolveStatePaths`) with mode `0o700` and names the file `<uuid>.<ext>`. The voice is resolved before
> the engine is spawned by `src/voice-routing.ts::resolveSayVoice` — the same
> function `kesha say` uses — falling back to `DEFAULT_VOICE_ID`, and passed to
> the engine explicitly so the reported id is the one that spoke (#942).*

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

> *Technical Note — the `kesha-audio://{file}` resource handler lives in
> `src/mcp/tools.ts::registerTools`, which sandboxes the parameter with
> `basename(String(file))` and picks the MIME type through its nested
> `src/mcp/tools.ts::registerTools::mimeForExt`.
> `src/mcp/audio-output.ts::sweepOldAudio` deletes files older than
> `src/mcp/audio-output.ts::MAX_AGE_MS`, which is `24 * 60 * 60 * 1000`.
> Audio directory: `src/mcp/audio-output.ts::audioDir`, which is the MCP audio
> path of `src/state-paths.ts::resolveStatePaths` — `<tmpdir>/kesha-mcp` by default,
> `<KESHA_HOME>/mcp-audio` under `KESHA_HOME`.*

### Requirement: Old MCP audio files are swept at server start

At every `kesha mcp` startup the server SHALL delete files in the MCP audio
directory (`<tmpdir>/kesha-mcp/` by default, `<KESHA_HOME>/mcp-audio/` when `KESHA_HOME`
is set — the `state-directories` resolution) whose modification time is more than 24 hours in the past, on a
best-effort basis (errors for individual files are silently ignored to handle
races and permission edge cases).

#### Scenario: Stale files cleaned at startup

- GIVEN `<tmpdir>/kesha-mcp/` contains files from 25 hours ago
- WHEN `kesha mcp` starts
- THEN those files are deleted before the first tool call is handled

#### Scenario: Sona runs the server under an isolated home

- GIVEN `KESHA_HOME=/tmp/kesha-agent` is set
- WHEN `kesha mcp` starts and `synthesize_speech` is called
- THEN the audio file lands in `/tmp/kesha-agent/mcp-audio/` with mode `0600`
- AND `<tmpdir>/kesha-mcp/` is neither created nor swept

#### Scenario: MCP directory does not yet exist

- GIVEN the MCP audio directory has never been created
- WHEN `kesha mcp` starts
- THEN `sweepOldAudio` returns without error (directory absence is silently
  ignored)

> *Technical Note — `sweepOldAudio()` is called by
> `src/mcp/server.ts::createKeshaMcpServer`. The sweep reads the directory with
> `readdirSync`; if the directory does not exist, the `catch` around that read
> silently returns, and individual file errors are caught per-file inside the
> loop — both in `src/mcp/audio-output.ts::sweepOldAudio`.*
