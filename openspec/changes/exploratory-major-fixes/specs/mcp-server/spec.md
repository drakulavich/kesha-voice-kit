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
