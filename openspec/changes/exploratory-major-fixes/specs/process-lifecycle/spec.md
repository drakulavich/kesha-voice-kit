## MODIFIED Requirements

### Requirement: An interrupted command terminates its Engine subprocess and reports the signal in its Exit code

When the CLI receives an interrupt, termination or hangup signal while an Engine subprocess is running, it SHALL terminate that subprocess and SHALL exit with the code conventionally derived from the signal — 130 for interrupt, 143 for termination, 129 for hangup — rather than with the command's own success or failure code. A hangup (the terminal closing) SHALL terminate the Engine tree exactly as a termination does, by forwarding termination to it: the Engine runs detached in its own process group, so the hangup never reaches it on its own. Windows, which has no terminal hangup, installs no hangup handler. This holds for transcription, Language detection, synthesis, recording, both `--list-voices` listings — the CLI command's and the MCP server's — alike, as well as the darwin Kokoro warmup, model installation, and executable health checks.

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

#### Scenario: Maks closes the terminal

- GIVEN Maks is transcribing a long recording in a terminal window
- WHEN he closes the window and the shell hangs the CLI up
- THEN the Engine subprocess is terminated as if the CLI had received a termination signal
- AND the CLI exits 129, reporting the file as `error [E_INTERRUPTED]: interrupted (SIGHUP)`
- AND no Engine process is left running at PPID 1

#### Scenario: A signal arrives when nothing is running

- GIVEN no Engine subprocess is active
- WHEN the CLI receives an interrupt
- THEN it still exits with the signal's code without waiting on a cleanup that
  has nothing to clean

> *Technical Note — `src/process-tree.ts::ensureSignalHandlers`
> installs one `SIGINT` handler (exit code 130), one `SIGTERM` handler (exit
> code 143) and, off Windows, one `SIGHUP` handler (exit code 129, forwarding
> `SIGTERM` to the tree) the first time any Engine process is registered.
> `src/process-tree.ts::terminateActiveProcessTrees` records which signal arrived first,
> sets `process.exitCode`, signals every
> registered process, then schedules the actual `process.exit`. With no active
> processes the delay is `SIGNAL_EXIT_BUFFER_MS` (50 ms) instead of the full
> grace window. `src/process-tree.ts::interruptedRun` turns a non-zero exit under
> that recorded signal into the `E_INTERRUPTED` KeshaError; `src/engine.ts::runEngine`,
> `src/synth.ts::say` and `src/synth.ts::listVoiceIds` consult it before reading the
> exit as a failure. These codes extend the Exit code taxonomy in the Glossary, and
> `docs/errors.md` lists them for callers scripting the CLI. All three signals are
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

### Requirement: A signal stops the queue, and the CLI exits as soon as its Engine is gone

Once a signal has been received, the CLI SHALL start no further queued file and SHALL spawn no further Engine subprocess, so the only Engine the signal has to terminate is the one that was running. Every file the signal kept from starting SHALL be reported as `E_INTERRUPTED` beside the one it cut short, in stderr and in the `--include-errors` envelope, and the results of files that finished before the signal SHALL still be written. The CLI SHALL then exit with the signal's Exit code as soon as the running Engine is gone, rather than sitting out the force-kill grace period; the grace period remains the ceiling for an Engine that ignores the signal.

#### Scenario: Ira interrupts a batch on its first file

- GIVEN Ira interrupts `kesha a.ogg b.ogg c.ogg` while `a.ogg` is being transcribed
- WHEN the Engine exits on the forwarded signal
- THEN `b.ogg` and `c.ogg` never start and no second Engine is spawned
- AND stderr reports all three files as `error [E_INTERRUPTED]: interrupted (SIGINT)`
- AND the CLI exits 130 well inside the force-kill grace period, leaving no Engine process behind

#### Scenario: A file finishes under the signal

- GIVEN the Engine transcribing a file exits 0 on the forwarded signal
- WHEN the CLI would next spawn an Engine for that file's language detection
- THEN the spawn is refused and the file is reported as `E_INTERRUPTED`

#### Scenario: A batch fails for reasons unrelated to any signal

- GIVEN no signal was received and every file failed
- WHEN the batch finishes
- THEN the CLI exits 1 as [transcription](../transcription/spec.md) specifies

> *Technical Note — `src/engine.ts::spawnEngineProcess` throws
> `src/process-tree.ts::pendingInterruption` once a signal is recorded, and the
> batch loop in `src/cli/main.ts::createMainCommand` records the same error for
> every file it skips. The cleanup promise `src/cli/main.ts` awaits through
> `src/process-tree.ts::waitForPendingSignalCleanup` now settles when the last
> registered process is disposed, not only when the grace timer fires; the timer
> stays as the backstop that exits a command which never awaits it. Pinned end to
> end in `tests/integration/cli-contracts.test.ts`.*

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
