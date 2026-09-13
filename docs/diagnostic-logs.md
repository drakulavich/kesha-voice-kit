# Diagnostic Logs

Kesha diagnostic logs are local, rotated NDJSON event logs for install, engine,
and runtime troubleshooting. They are separate from Kesha Stats: Stats stores
aggregate timings in SQLite after explicit opt-in, while diagnostic logs keep a
small local ring buffer of structured events.

Diagnostic logs default to `retain-on-failure`: passing commands leave no log
file, while failed commands can preserve a small local trace for debugging.

```bash
kesha logs status
kesha logs status --json
kesha logs enable
kesha logs disable
kesha logs mode retain-on-failure
kesha logs path
kesha logs reset
```

## Modes

Diagnostic logs follow a Playwright-style retention model:

- `off`: do not record diagnostic events.
- `on`: append events to the rotated local log immediately.
- `retain-on-failure`: buffer events for the current command and write them only
  if the command fails. This is the default.

`kesha logs enable` is shorthand for `kesha logs mode on`; `kesha logs disable`
is shorthand for `kesha logs mode off`. `retain-on-failure` keeps passing runs
artifact-free while failed runs keep enough context to debug.

`kesha logs status --json` prints the same local status as a stable JSON object:
`dir`, `activePath`, `statePath`, `exists`, `activeSizeBytes`, `rotatedFiles`,
`totalSizeBytes`, `mode`, `maxBytes`, and `retain`.

## Privacy Contract

Diagnostic logs are content-free. Event payloads are built from an allowlist of
typed fields such as command name, app version, platform, backend, feature flags,
stage names, exit codes, duration numbers, and stable error codes.

When enabled, `kesha install`, `kesha <audio>`, and `kesha say` record command
lifecycle events such as `command.start`, `input.audio`, `input.missing`,
`engine.exit`, `engine.debug` (the Engine's own `KESHA_DEBUG` timeline, carrying
its event name and typed fields but never its message text), and `command.finish`.
These events use only counts, booleans, format extensions, duration milliseconds,
and bucket labels. In the default `retain-on-failure` mode, successful runs still
leave no log file behind.

Diagnostic logs must not store:

- audio bytes
- transcripts
- input text or generated speech text
- file names, basenames, or full file paths
- raw stdout or stderr
- environment variables
- URLs, tokens, secrets, API keys, or cloud identifiers
- model files or model contents

For audio shape, logs should use coarse metadata such as extension, duration
bucket, size bucket, sample-rate bucket, or channel count. Do not log a path or
basename even when it looks harmless; names like `therapy-session.m4a` can be
private.

## Storage

Default paths:

- macOS: `~/Library/Logs/kesha/kesha.ndjson`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/kesha/logs/kesha.ndjson`
- Windows: `%LOCALAPPDATA%\kesha\logs\kesha.ndjson`

Set `KESHA_LOG_DIR` to override the directory. The active file is
`kesha.ndjson`; rotated files are named `kesha.1.ndjson`, `kesha.2.ndjson`, and
so on.

## Where Kesha keeps its files

Kesha writes to four places. Each resolves by the same rule: its own variable
when set, otherwise the path under `KESHA_HOME` when that is set, otherwise the
platform default. `KESHA_HOME` uses one layout on every platform, so a test run,
a CI job or a second profile needs exactly one variable to leave your real
models, logs and Stats untouched. Nothing is moved when you set it: a fresh
`KESHA_HOME` starts with an empty cache, and `kesha install` fills it.

| What | Default (macOS / Windows / Linux) | Under `KESHA_HOME` | Own variable |
|---|---|---|---|
| Model cache: engine, models, `recordings/`, FluidAudio bundles | `~/.cache/kesha` everywhere | `<home>/cache` | `KESHA_CACHE_DIR` |
| Diagnostic log directory | `~/Library/Logs/kesha` / `%LOCALAPPDATA%\kesha\logs` / `$XDG_STATE_HOME/kesha/logs` | `<home>/logs` | `KESHA_LOG_DIR` |
| Stats DB | `~/Library/Application Support/kesha/stats.sqlite` / `%APPDATA%\kesha\stats.sqlite` / `$XDG_DATA_HOME/kesha/stats.sqlite` | `<home>/stats.sqlite` | `KESHA_STATS_DB` |
| MCP audio (`kesha mcp` synthesis output) | `<tmpdir>/kesha-mcp` | `<home>/mcp-audio` | none |

`kesha status --json` and `kesha doctor --json` report every path together with
the rule that decided it (`default`, `KESHA_HOME`, or the variable name), so an
isolated run can be verified from one command:

```bash
KESHA_HOME=/tmp/kesha-ci kesha status --json | jq .paths
```

An empty variable counts as unset; a relative path is resolved against the
working directory when the command starts. The engine itself reads only
`KESHA_CACHE_DIR`, so the CLI hands it the resolved cache root under that name
whenever `KESHA_HOME` decided it. FluidAudio's own Silero VAD copy under
`~/Library/Application Support/FluidAudio` is placed by FluidAudio and stays
outside `KESHA_HOME`; `kesha status --disk` lists it as an external root.

The first implementation rotates at 10 MB and keeps 5 rotated files. `kesha logs
reset` deletes Kesha log files but preserves the selected mode.

## Support Bundles

`kesha support-bundle` does not include diagnostic log contents by default. Use
`kesha support-bundle --include-logs` to add a bounded tail of the active
already-sanitized NDJSON log when a support issue needs recent command events.
Recommended flow for a bug report:

```bash
kesha logs status
kesha logs mode retain-on-failure
# reproduce the failure
kesha support-bundle --include-logs --output kesha-support-with-logs.tar.gz
```

## Error codes

Failure events record a stable `error_code` field (leak-free by construction).
The same code is printed to stderr as `error [CODE]: …` and recorded in Stats.
See [Error codes](errors.md) for the full reference.
