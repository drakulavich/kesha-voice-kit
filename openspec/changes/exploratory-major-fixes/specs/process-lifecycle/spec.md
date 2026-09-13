## MODIFIED Requirements

### Requirement: A programmatic abort is a distinguishable outcome, not an empty result

When a caller of the Core API cancels an in-flight call, the call SHALL fail with a `KeshaError` whose `code` is `E_INTERRUPTED` rather than returning a partial or empty result, and the Engine subprocess it started SHALL be terminated. The error's `origin` is `cli`, its `exitCode` is 130, its `hint` names the caller's `AbortSignal`, and its `name` stays `AbortError` so callers matching on the name keep working.

#### Scenario: Sona cancels a transcription from her agent

- GIVEN Sona passed an abort signal into a Core API call and the Engine is
  running
- WHEN she aborts it
- THEN the call rejects with a `KeshaError` whose `code` is `E_INTERRUPTED`
- AND `err instanceof KeshaError` holds, so her one coded-error handler sees it
- AND the Engine subprocess is terminated, escalating to a force kill if needed

#### Scenario: The signal is already aborted before the call starts

- GIVEN Sona passes an already-aborted signal
- WHEN she makes the call
- THEN it rejects with the same `E_INTERRUPTED` error without spawning an Engine at all

> *Technical Note — `src/process-tree.ts::engineAbortError` returns a
> `KeshaError("E_INTERRUPTED")` with `exitCode: 130`, a hint naming the
> `AbortSignal`, and `name = "AbortError"`. `src/engine.ts::runEngine` rejects
> on an already-aborted signal before spawning; its abort listener terminates
> the tree and arms the force kill, and the same function converts the completed
> run into the abort error. `src/engine/events.ts::CLI_EXIT_CODES` maps the code
> to 130 for a CLI that raises it without an explicit `exitCode`.*
