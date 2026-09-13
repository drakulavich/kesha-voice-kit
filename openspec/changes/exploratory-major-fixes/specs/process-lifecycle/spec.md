## MODIFIED Requirements

### Requirement: An interrupted command terminates its Engine subprocess and reports the signal in its Exit code

When the CLI receives an interrupt or termination signal while an Engine subprocess is running, it SHALL terminate that subprocess and SHALL exit with the code conventionally derived from the signal — 130 for interrupt, 143 for termination — rather than with the command's own success or failure code. This holds for transcription, Language detection, synthesis, recording, both `--list-voices` listings — the CLI command's and the MCP server's — alike, as well as the darwin Kokoro warmup, model installation, and executable health checks.

A run the signal cut short SHALL be reported as the CLI-origin Error code `E_INTERRUPTED`, never as `E_INTERNAL`: an Engine that exits 130 or 143 because the CLI forwarded the signal is a cancellation, not an uncoded failure. The message SHALL name the signal the CLI received — `error [E_INTERRUPTED]: interrupted (SIGINT)` — and SHALL carry no hint to file a bug. A run that still exited 0 keeps its output.

#### Scenario: Maks interrupts a long transcription

- GIVEN Maks is transcribing a two-hour recording
- WHEN Maks presses Ctrl-C
- THEN the Engine subprocess is terminated
- AND stderr reports the file as `error [E_INTERRUPTED]: interrupted (SIGINT)`
- AND the CLI exits 130
- AND no Engine process is left running

#### Scenario: Ira's CI job is cancelled

- GIVEN Ira's pipeline sends a termination signal to `kesha` mid-batch
- WHEN the signal arrives
- THEN the Engine subprocess is terminated and the CLI exits 143
- AND the interrupted file is reported as `error [E_INTERRUPTED]: interrupted (SIGTERM)`
- AND no Engine process is left running

#### Scenario: A wrapper greps stderr for coded errors

- GIVEN a wrapper treats every `error [E_` line as a failure to investigate
- WHEN the run it drives is cancelled with Ctrl-C
- THEN the only coded line it sees is `E_INTERRUPTED`, which its catalog entry says is a cancellation
- AND no `E_INTERNAL` line asks it to file a bug

#### Scenario: A signal arrives when nothing is running

- GIVEN no Engine subprocess is active
- WHEN the CLI receives an interrupt
- THEN it still exits with the signal's code without waiting on a cleanup that
  has nothing to clean

> *Technical Note — `src/process-tree.ts::ensureSignalHandlers`
> installs one `SIGINT` handler (exit code 130) and one `SIGTERM` handler (exit
> code 143) the first time any Engine process is registered.
> `src/process-tree.ts::terminateActiveProcessTrees` records which signal arrived first,
> sets `process.exitCode`, signals every
> registered process, then schedules the actual `process.exit`. With no active
> processes the delay is `SIGNAL_EXIT_BUFFER_MS` (50 ms) instead of the full
> grace window. `src/process-tree.ts::interruptedRun` turns a non-zero exit under
> that recorded signal into the `E_INTERRUPTED` KeshaError; `src/engine.ts::runEngine`,
> `src/synth.ts::say` and `src/synth.ts::listVoiceIds` consult it before reading the
> exit as a failure. These codes extend the Exit code taxonomy in the Glossary, and
> `docs/errors.md` lists them for callers scripting the CLI. Both signals are
> asserted end to end in `tests/integration/cli-contracts.test.ts` (#940).*

### Requirement: A subprocess that ignores the first signal is force-killed

The CLI SHALL escalate to an unignorable kill after a bounded grace period, so a subprocess wedged inside a native call cannot hold the terminal open indefinitely. The escalation SHALL NOT change what the user is told: the report still names the signal the CLI received, not the kill it had to send.

#### Scenario: The Engine is wedged in a native call

- GIVEN the Engine is inside a CoreML call that does not observe the first
  signal
- WHEN Maks presses Ctrl-C
- THEN the Engine is force-killed shortly afterwards and the CLI exits 130
- AND stderr says `interrupted (SIGINT)`, with no mention of the force kill or of exit status 137

#### Scenario: The Engine exits cooperatively

- GIVEN the Engine handles the first signal and exits promptly
- WHEN it exits before the grace period elapses
- THEN no force kill is needed, and the CLI still exits with the signal's code

> *Technical Note — `src/process-tree.ts::FORCE_KILL_GRACE_MS` is 1 000 ms;
> `src/process-tree.ts::scheduleForceKill` arms the escalation.
> During signal cleanup the timer is deliberately `ref`'d so the escalation
> survives an otherwise-idle event loop, whereas the timer armed for a
> programmatic abort is `unref`'d. The message comes from the signal
> `terminateActiveProcessTrees` recorded, so the Engine's own wait status (137
> after the force kill) never reaches the user.*
