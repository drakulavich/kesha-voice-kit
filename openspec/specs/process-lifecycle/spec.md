# Process Lifecycle Specification

## Purpose

Every command that does real work spawns the Engine as a subprocess, and some of
those runs take minutes. This spec covers what happens when such a run is
interrupted: which processes are terminated, how long they are given, what exit
code the CLI reports, and what a caller who cancels programmatically observes.

It covers the spawns that opt in by registering themselves. Two short-lived
spawns do not, and are listed under Open Issues rather than quietly implied.

Ira runs batches in CI where a job cancellation must not leave a model-loading
Engine holding a runner's CPU. Maks presses Ctrl-C on a long meeting
transcription and expects his terminal back. Sona cancels an in-flight call from
her agent and needs a distinguishable outcome rather than an empty transcript.

## Non-Goals

- The Raycast extension's own termination ladder, which manages processes it
  spawned itself — see [raycast-extension](../raycast-extension/spec.md).
- Partial-download cleanup when an install is interrupted — see
  [installation](../installation/spec.md).
- Cooperative stop conditions that are not interruptions: `kesha record` ending
  on stdin EOF or `--max-seconds`
  ([audio-recording](../audio-recording/spec.md)), and Diarization's adaptive
  timeout ([speaker-diarization](../speaker-diarization/spec.md)).
- Signal handling inside the Engine itself; this spec covers what the CLI does
  to the Engine.

## Requirements

### Requirement: An interrupted command terminates the registered Engine subprocess and reports the signal in its Exit code

When the CLI receives an interrupt or termination signal while a registered Engine subprocess is running, it SHALL terminate that subprocess and SHALL exit with the code conventionally derived from the signal — 130 for interrupt, 143 for termination — rather than with the command's own success or failure code. Transcription, Language detection, synthesis, and recording register; the two `--list-voices` spawns do not (see Open Issues).

#### Scenario: Maks interrupts a long transcription

- GIVEN Maks is transcribing a two-hour recording
- WHEN Maks presses Ctrl-C
- THEN the Engine subprocess is terminated
- AND the CLI exits 130
- AND no Engine process is left running

#### Scenario: Ira's CI job is cancelled

- GIVEN Ira's pipeline sends a termination signal to `kesha` mid-batch
- WHEN the signal arrives
- THEN the Engine subprocess is terminated and the CLI exits 143

#### Scenario: A signal arrives when nothing is running

- GIVEN no Engine subprocess is active
- WHEN the CLI receives an interrupt
- THEN it still exits with the signal's code without waiting on a cleanup that
  has nothing to clean

> *Technical Note — `ensureSignalHandlers` (`src/process-tree.ts:101-107`)
> installs one `SIGINT` handler (exit code 130) and one `SIGTERM` handler (exit
> code 143) the first time any Engine process is registered.
> `terminateActiveProcessTrees` (`:109`) sets `process.exitCode`, signals every
> registered process, then schedules the actual `process.exit`. With no active
> processes the delay is `SIGNAL_EXIT_BUFFER_MS` (50 ms) instead of the full
> grace window. These codes extend the Exit code taxonomy in the Glossary.*

### Requirement: Termination targets the whole process tree, not just the direct child

The CLI SHALL terminate the Engine's whole process tree, so that helpers the Engine spawned — the AVSpeech and text-language Sidecars among them — do not survive the run that started them.

#### Scenario: Maks interrupts a synthesis that is driving a Sidecar

- GIVEN `kesha say` is running with a `macos-*` Voice id, so the AVSpeech
  Sidecar is running under the Engine
- WHEN Maks presses Ctrl-C
- THEN both the Engine and the Sidecar are terminated

#### Scenario: The process tree cannot be addressed

- GIVEN the subprocess has no usable process id, or the platform call to signal
  the group fails
- WHEN termination runs
- THEN the CLI falls back to signalling the direct child, and a child that has
  already exited is not treated as an error

> *Technical Note — `terminateProcessTree` (`src/process-tree.ts:60`) signals
> the negated pid (the process group) on POSIX and shells out to `taskkill /PID
> <pid> /T` (adding `/F` for a force kill) on Windows; both fall back to
> `safeKillDirect` (`:88`), which swallows the error from a process that exited
> between the decision and the signal. Registration happens in `src/engine.ts`
> (`:152`, `:454`) and `src/synth.ts:177`.*

### Requirement: A subprocess that ignores the first signal is force-killed

The CLI SHALL escalate to an unignorable kill after a bounded grace period, so a subprocess wedged inside a native call cannot hold the terminal open indefinitely.

#### Scenario: The Engine is wedged in a native call

- GIVEN the Engine is inside a CoreML call that does not observe the first
  signal
- WHEN Maks presses Ctrl-C
- THEN the Engine is force-killed shortly afterwards and the CLI exits 130

#### Scenario: The Engine exits cooperatively

- GIVEN the Engine handles the first signal and exits promptly
- WHEN it exits before the grace period elapses
- THEN no force kill is needed, and the CLI still exits with the signal's code

> *Technical Note — `FORCE_KILL_GRACE_MS` is 1 000 ms
> (`src/process-tree.ts:13`); `scheduleForceKill` (`:96`) arms the escalation.
> During signal cleanup the timer is deliberately `ref`'d so the escalation
> survives an otherwise-idle event loop, whereas the timer armed for a
> programmatic abort is `unref`'d.*

### Requirement: The CLI does not exit before cleanup has had its window

The CLI SHALL let signal cleanup complete before exiting, so an interrupted command reports the signal's Exit code rather than racing its own failure path, and no subprocess outlives the CLI.

#### Scenario: A batch fails because its files were interrupted

- GIVEN Ira interrupts `kesha a.ogg b.ogg c.ogg` partway through
- WHEN the interrupted files are recorded as failures
- THEN the CLI waits for the pending cleanup and exits 130, not 1

#### Scenario: A batch fails for reasons unrelated to any signal

- GIVEN no signal was received and every file failed
- WHEN the batch finishes
- THEN the CLI exits 1 as [transcription](../transcription/spec.md) specifies

> *Technical Note — `src/cli/main.ts:612-619` checks
> `getPendingSignalExitCode()` before the generic `process.exit(1)` and awaits
> `waitForPendingSignalCleanup()` when one is pending. The cleanup promise
> resolves after `FORCE_KILL_GRACE_MS + SIGNAL_EXIT_BUFFER_MS` when processes
> were signalled (`src/process-tree.ts:122-132`).*

### Requirement: A programmatic abort is a distinguishable outcome, not an empty result

When a caller of the Core API cancels an in-flight call, the call SHALL fail with an abort error rather than returning a partial or empty result, and the Engine subprocess it started SHALL be terminated.

#### Scenario: Sona cancels a transcription from her agent

- GIVEN Sona passed an abort signal into a Core API call and the Engine is
  running
- WHEN she aborts it
- THEN the call rejects with an error named `AbortError`
- AND the Engine subprocess is terminated, escalating to a force kill if needed

#### Scenario: The signal is already aborted before the call starts

- GIVEN Sona passes an already-aborted signal
- WHEN she makes the call
- THEN it rejects with the same abort error without spawning an Engine at all

> *Technical Note — `engineAbortError` (`src/process-tree.ts:24`) returns an
> `Error` with `name = "AbortError"` and the message `kesha-engine process
> aborted`. `src/engine.ts:147` rejects on an already-aborted signal before
> spawning; the abort listener at `:155-160` terminates the tree and arms the
> force kill, and `:185` converts the completed run into the abort error. The
> abort path is not reachable from the CLI — see Open Issues.*

## Open Issues

- Exit codes 130 and 143 are not documented in `docs/errors.md` alongside 0/1/2
  (and `say`'s 4/5), and the Glossary's Exit code entry did not list them before
  this spec. Nothing tests them end to end.
- The abort path (`opts.signal`) is reachable only from the Core API; no CLI
  flag or timeout wires an `AbortSignal` into a run. The Raycast extension gets
  its cancellation by killing the CLI process instead, which lands on the signal
  path above rather than this one.
- `waitForPendingSignalCleanup` is consulted only in the main transcription
  command (`src/cli/main.ts`). `kesha say`, `kesha record`, and `kesha install`
  rely on the handler's own `process.exit`, so their interrupted exit code is
  set by the same handler but never awaited by the command — whether that can
  race a command-owned `process.exit` is untested.
- The Windows path spawns `taskkill` and does not wait for it, so on Windows the
  tree kill is fire-and-forget; nothing verifies it completed before the CLI
  exits.
- **Two Engine spawns never register.** `kesha say --list-voices`
  (`src/cli/say.ts:315`) and the MCP `listVoices` (`src/mcp/voices.ts:115`) both
  call `spawnEngineProcess` directly and await it without
  `registerProcessTree`, so they join no process tree and install no signal
  handler of their own. Interrupting either leaves the Engine to be reaped by
  the shell rather than terminated by the CLI. Both are short-lived, which is
  presumably why it never surfaced — but "short-lived" is not the contract this
  spec states, and an Engine cold-load can take seconds.
