## Why

An eleven-session exploratory programme (2026-09-13, CLI 1.30.0 / engine v1.25.0, findings journal artifact `7c22a5a2`) recorded 130 findings, 39 of them **major**: the contract is stated in a spec or in `docs/errors.md`, a user or an agent relies on it, and the product does something else. They cluster around six habits rather than six bugs: unknown or misplaced flags are silently accepted; a user's own cancellation is reported as `E_INTERNAL`; caller errors are coded as internal ones; `--quiet` and `--verbose` move text to the wrong channel; the language fields are populated with no confidence floor; and process trees outlive their owner (SIGKILL, SIGHUP, a dead MCP client, an MCP cancel). This change fixes all 39 in one PR so the next exploratory pass starts from a clean baseline.

## What Changes

- **Argument handling** (S1-1, S1-5, S2-5, S3-F3, S9-F1, S9-F2, S9-F3, S10-1): unknown flags, a missing input, a mutually exclusive pair, a missing shell name and a global flag before a subcommand are all refused before any spawn with one `error [E_INVALID_ARG]: …` line on stderr and exit 2; stdout stays empty; the transcribe path exits 2 for a CLI-origin `E_INVALID_ARG` like every other command.
- **Cancellation** (S1-4, S6-2, S6-3, S6-4, S6-5, S8-1): a new CLI-origin code `E_INTERRUPTED` replaces `E_INTERNAL` for a run the user stopped; the line names the signal the CLI received, not the one it escalated to; no queued file starts after the signal; SIGHUP is handled like SIGTERM; an aborted `transcribe()` rejects with a `KeshaError` carrying that code.
- **Error classes** (S2-2, S2-3, S2-4, S3-F4, S8-3): a container declaring no sample rate is `E_BAD_AUDIO` with no panic text; AIFF is decoded or the claim is withdrawn and the message stops blaming ADTS; the `--no-vad` ceiling and a bad `--out` are `E_INVALID_ARG`; `transcribe()` on a directory is `E_INVALID_ARG` like the CLI.
- **Channels and quiet** (S1-2, S1-3, S3-F2, S5-F4, S11-3): `--verbose` diagnostics and the support-bundle report go to stderr; `--quiet` keeps warnings and the `record` result lines; diarization progress obeys `--quiet`.
- **Language fields** (S11-1, S11-2, S11-4): `--lang` compares case-folded primary subtags; a text or audio guess below a 0.5 floor no longer populates `lang`, the raw fields are unchanged.
- **Process trees and clients** (S3-F1, S7-1, S7-2): the engine's `record` stops when its parent dies; an MCP cancel stops the engine; `kesha mcp` exits on stdin EOF even with a call in flight.
- **Diagnostics and Stats** (S5-F1, S5-F2, S5-F3, S9-F5): `versionMarker` is redacted; `stats export` without `--format` and `stats retention -5` are rejected; engine debug events reach the diagnostic log.
- **Lifecycle** (S4-F1, S4-F2, S8-2, S8-8, S10-2): `init` cancelled at a prompt exits 130; a stale install lock (dead pid, same host) is broken and the hint is printed at the start of the wait; `downloadEngine` is exported; `transcribe` emits progress events so `onProgressLine` fires; completions fall back to file paths.

The `diagnostics` capability changes in implementation only: its spec already required the usage line for `stats export`, the rejection of a bad retention value, the support-bundle report on stderr and debug events in the log, so no delta is needed.

Not in scope: the two **blocker** findings (the `sr=1` WAV memory runaway and the batch-interrupt orphan are tracked separately), every minor, question and idea row, and the `homedir()` vs `$HOME` split recorded in `state-directories`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `cli-shell-integration`: usage errors carry a stable code and exit 2; unknown flags are refused; completions keep file-path completion.
- `process-lifecycle`: `E_INTERRUPTED`, SIGHUP, no new work after a signal, parent-death stop in `record`.
- `audio-ingest`: sample-rate-0 and AIFF behaviour.
- `audio-recording`: `--out` failures are `E_INVALID_ARG`; quiet keeps the result line.
- `transcription`: `--verbose` on stderr; progress events during a plain transcribe.
- `language-detection`: `--lang` normalisation and the routing floor.
- `mcp-server`: cancel stops the engine; stdin EOF ends the server mid-call.
- `programmatic-api`: `E_INTERRUPTED` on abort, `E_INVALID_ARG` on a directory, `downloadEngine` exported, `onProgressLine` fires.
- `installation`: `init` cancel exit code; stale-lock liveness.
- `engine-contract`: the new `progress` events from `transcribe`, `E_INVALID_ARG` for the two engine-side caller errors.

## Impact

`src/cli/main.ts` (parser, routing, channels), `src/engine.ts` and `src/engine/events.ts` (signals, `E_INTERRUPTED`, exit codes), `src/transcribe.ts`, `src/lib.ts`, `src/mcp/*`, `src/doctor.ts`, `src/support-bundle.ts`, `src/stats.ts`, `src/diagnostic-log.ts`, `src/engine/command-session.ts`, `src/init*`, `src/install-lock.ts`, the completion scripts; `rust/src/` audio open path, `transcribe` events, `record` parent watch, `--out` and `--no-vad` error codes; `docs/errors.md` gains one row and changes the class of four cases; `tests/helpers/fake-engine.ts` mirrors the new event shape. No protocol version change: protocol 4 already carries `progress` events.
