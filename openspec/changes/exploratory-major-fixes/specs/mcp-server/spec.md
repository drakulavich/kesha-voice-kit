## MODIFIED Requirements

### Requirement: `kesha mcp` starts a named MCP stdio server

The CLI SHALL start an MCP server named `kesha-voice-kit` over stdio and block
until the client disconnects. The server version matches the CLI package
version. At server start, audio files older than 24 hours in the MCP audio
directory are swept.

The server exposes four tools (`transcribe_audio`, `synthesize_speech`,
`list_voices`, `list_languages`) and one resource template
(`kesha-audio://{file}`).

When the client's side of stdin reaches EOF — the client exited, crashed or
closed the pipe — the server SHALL stop even while a tool call is outstanding:
the in-flight call is cancelled, the Engine subprocess it started is
terminated, and the process exits rather than being reparented to init with a
running Engine.

#### Scenario: Sona configures kesha mcp in her agent

- GIVEN Sona adds `{ command: "kesha", args: ["mcp"] }` to her MCP client
- WHEN the client initializes the connection
- THEN the server announces itself as `kesha-voice-kit`
- AND the four tools appear in the tools list
- AND the kesha-audio resource template appears in the resources list
- AND the server remains running until the client closes the connection

#### Scenario: Sona's agent dies while a transcription is in flight

- GIVEN Sona's agent called `transcribe_audio` on a long recording and the Engine is running
- WHEN the agent process exits, closing the server's stdin
- THEN the Engine subprocess is terminated
- AND the `kesha mcp` process exits
- AND no process from that session is left running

#### Scenario: The client disconnects with nothing in flight

- GIVEN no tool call is outstanding
- WHEN the client closes the connection
- THEN the server exits promptly

> *Technical Note — `src/cli/mcp.ts::mcpCommand` creates the server via
> `createKeshaMcpServer()` (`src/mcp/server.ts::createKeshaMcpServer`) and
> connects a `StdioServerTransport`; the SDK transport never watches stdin for
> EOF, so the command listens for `end` itself and closes the server, which
> aborts every in-flight request handler and, through the forwarded signal,
> terminates its Engine. `sweepOldAudio()` runs at server creation, and the
> server name is `"kesha-voice-kit"` — both inside
> `src/mcp/server.ts::createKeshaMcpServer`.*

## ADDED Requirements

### Requirement: A cancelled tool call stops the Engine it started

When an MCP client cancels an in-flight `transcribe_audio` or `synthesize_speech` request, the server SHALL terminate the Engine subprocess that request started rather than let it run to completion, so repeated cancellations never accumulate live Engines. A request that arrives already cancelled SHALL spawn no Engine.

#### Scenario: Sona cancels a long transcription

- GIVEN Sona's agent called `transcribe_audio` on a 30-minute recording and the Engine is running
- WHEN the client sends the MCP cancellation for that request
- THEN the Engine subprocess is terminated, escalating to a force kill if needed
- AND no Engine process from that request is left running

#### Scenario: Sona cancels three times in a row

- GIVEN Sona's agent starts and cancels `transcribe_audio` three times
- WHEN the third cancellation is delivered
- THEN no Engine process from any of the three requests is running

#### Scenario: The request is cancelled before the Engine starts

- GIVEN a `synthesize_speech` request whose cancellation arrives before the handler runs
- WHEN the handler observes the cancelled request
- THEN it returns `isError: true` and no Engine is spawned

> *Technical Note — `src/mcp/tools.ts::registerTools` forwards the request's
> `extra.signal` into `transcribe`/`transcribeWithTimestamps` (`src/lib.ts`)
> and into `say` (`src/synth.ts::say`, which accepts `SayOptions.signal`) and
> `resolveSayVoice` (`src/voice-routing.ts`). Every spawn wires the signal
> through `src/process-tree.ts::abortOnSignal`, the same helper
> `src/engine.ts::runEngine` uses, and the cancelled call rejects with
> `E_INTERRUPTED`. `list_voices` and `list_languages` do not take the signal:
> their spawn is sub-second and is reaped on server exit.*
