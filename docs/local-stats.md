# Local Stats — privacy & lifecycle

Kesha Stats is disabled by default. When you opt in with `kesha stats enable`,
Kesha writes a local SQLite database only on your machine:

```bash
kesha stats status
kesha stats week
kesha stats errors
kesha stats export --format json   # or csv
kesha stats retention 30           # default: 90 days
kesha stats retention off          # keep until reset
kesha stats reset                  # delete recorded stats rows
kesha stats vacuum                 # compact the SQLite file
```

The database stores content-free operational records only: command name
(`transcribe` or `say`), timestamps, success/failure status, app version, item
count, anonymous stage timings, input/output artifact kind, file extension,
size, optional duration/sample-rate/channel counts, and sanitized error
class/code/message.

Stats never stores audio bytes, transcripts, input text, generated speech text,
file names, full file paths, raw stdout/stderr, environment variables, model
files, API tokens, or cloud identifiers. `support-bundle` reports Stats status
only; it never includes the Stats SQLite database.

By default, Stats prunes rows older than 90 days before writing or exporting
data. Use `kesha stats retention <days>` to change the TTL or `kesha stats
retention off` to disable TTL pruning. `kesha stats reset` deletes recorded
runs, artifacts, timings, and errors while preserving settings such as enabled
state and retention.
