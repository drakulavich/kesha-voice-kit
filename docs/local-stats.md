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
retention off` to disable TTL pruning; `<days>` is a whole number from 1 to
100000000. `kesha stats reset` deletes recorded runs, artifacts, timings, and
errors while preserving settings such as enabled state and retention.

If the database file cannot be opened, every `kesha stats` action, `disable`
and `reset` included, fails with `E_INTERNAL` naming the file, and each
`kesha` run warns once that it is continuing without Stats. When the file is
not SQLite or is damaged, delete it to start over; Stats stays off until
`kesha stats enable` creates a new database. Any other failure, such as a
permission error or a read-only disk, leaves the file alone: make the file and
its folder readable and writable, or point `KESHA_STATS_DB` at another file.
