## MODIFIED Requirements

### Requirement: Engine stderr is an event stream

The Engine SHALL write every non-payload line to stderr as one JSON object per line with a `kind` of `progress`, `warn`, `error` or `debug` and a `message`; `error` and `warn` SHALL each carry a `code` that is one of the published codes, and `error` MAY carry a `hint`. Diagnostics that a linked library writes to the Engine's file descriptor 2 on its own (the FluidAudio bridge on darwin-arm64) SHALL be captured and re-emitted as events — a `warn` on a successful call, or folded into the coded `error` of a failed one — so no raw library line ever reaches the CLI. Argument-parsing failures SHALL join the Event stream rather than bypass it: a clap parse error and a missing subcommand SHALL each be emitted as one `error` event whose `code` is `E_INVALID_ARG` and whose `message` contains the usage text, and the process SHALL exit 2.

The CLI SHALL render events for humans and SHALL treat a stderr line that is not a JSON object as `E_INTERNAL`, quoting at most the first 200 characters of the line once, never echoing the user's whole input. The CLI SHALL accept `\r\n` line endings.

#### Scenario: A library warning stays on the event stream

- GIVEN a word FluidAudio's G2P cannot encode
- WHEN the Engine synthesizes it on darwin-arm64
- THEN the failure reaches the CLI as one coded `error` event and the library's own diagnostic as a `warn` event or inside that error's message
- AND the CLI prints one `error [E_SCRIPT_UNSUPPORTED]: …` line and no unprefixed line

#### Scenario: A line that is not JSON

- GIVEN the Engine crashes and the runtime prints a panic message to stderr
- WHEN the CLI parses stderr
- THEN the failure is reported as `E_INTERNAL` with the first 200 characters of the raw line in the message
