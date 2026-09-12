## Why

`kesha record --live | head -1` delivered the first line and then kept the microphone open until `--max-seconds` (120 s by default): the relay's stdout write failed silently once the reader left — the #1001 guard keeps the EPIPE off stderr — and nothing told the Engine its reader was gone (#1187). The audio-recording spec enumerates two stop conditions, `--max-seconds` and stdin EOF, so the behaviour was neither required nor forbidden.

## What Changes

- The `--live` requirement names a third stop: the reader of stdout closing the pipe. The CLI stops writing, keeps draining the Engine's stdout, sends one `SIGTERM`, and judges the Engine's exit as it judges any other live stop.
- The stop-conditions requirement records that under `--live` the CLI, not the Engine, adds that stop.

## Capabilities

### Modified Capabilities

- `audio-recording`: `--live` stops when its reader leaves.

## Impact

- `src/engine.ts`: `forwardStdout` reports EPIPE through the write callback; `recordEngine` sends `SIGTERM` once.
- `tests/integration/cli-contracts.test.ts`: the reader-left contract case.
- Landed by PR #1195; this change is archived by the sync that follows it.

## Non-goals

- `--out` writes nothing to stdout, so no reader can leave; unchanged.
- The Engine's own stop conditions are unchanged.
