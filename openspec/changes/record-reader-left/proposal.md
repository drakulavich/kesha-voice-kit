## Why

Since #1185 the CLI relays the Engine's stdout instead of inheriting it, so it sits between the Engine and whatever the user piped `kesha record --live` into. #1187 asked what the relay does when that reader leaves: a failed stdout write was swallowed (the #1001 guard keeps the EPIPE off stderr) and nothing told the Engine its reader was gone, so an Engine that streamed lines would hold the microphone until `--max-seconds`. The shipped Engine cannot reach that state — it delivers the transcript in one write after recording has stopped — so this is the relay's contract for the streaming case, pinned with a fake streaming Engine, not a fix for a defect a user sees today. The audio-recording spec enumerated two stop conditions, `--max-seconds` and stdin EOF, and said nothing about the reader.

## What Changes

- The `--live` requirement gains the relay's contract for a failed stdout write: stop writing, keep draining the Engine's stdout, send one `SIGTERM`, judge the Engine's exit as any other live stop — and states that the shipped Engine cannot reach it.
- The stop-conditions requirement records that under `--live` the CLI, not the Engine, adds that stop.

## Capabilities

### Modified Capabilities

- `audio-recording`: the relay stops the Engine when a stdout write fails because the reader left.

## Impact

- `src/engine.ts`: `forwardStdout` reports EPIPE through the write callback; `recordEngine` sends `SIGTERM` once.
- `tests/integration/cli-contracts.test.ts`: the reader-left contract case.
- Landed by PR #1195; this change is archived by the sync that follows it.

## Non-goals

- `--out` writes nothing to stdout, so no reader can leave; unchanged.
- The Engine's own stop conditions are unchanged.
