# Diagnostic Logs

Kesha diagnostic logs are local, rotated NDJSON event logs for install, engine,
and runtime troubleshooting. They are separate from Kesha Stats: Stats stores
aggregate timings in SQLite after explicit opt-in, while diagnostic logs keep a
small local ring buffer of structured events.

Diagnostic logs are disabled by default:

```bash
kesha logs status
kesha logs enable
kesha logs disable
kesha logs path
kesha logs reset
```

## Privacy Contract

Diagnostic logs are content-free. Event payloads are built from an allowlist of
typed fields such as command name, app version, platform, backend, feature flags,
stage names, exit codes, duration numbers, and stable error codes.

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

The first implementation rotates at 10 MB and keeps 5 rotated files. `kesha logs
reset` deletes Kesha log files but preserves the enabled/disabled setting.

## Support Bundles

`kesha support-bundle` does not include diagnostic log contents by default. A
future opt-in flag may include a bounded tail of already-sanitized NDJSON, but
users should always explicitly choose that.
