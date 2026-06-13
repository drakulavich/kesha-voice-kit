# Diagnostics Specification

## Purpose

Diagnostics is a family of read-oriented (or carefully scoped write) commands that
let Ira debug a broken installation, Maks understand what is installed, and Sona
package evidence for a support request — all without touching audio data or
transcripts. The five commands are `kesha doctor`, `kesha status`, `kesha logs`,
`kesha stats`, and `kesha support-bundle`. Every one of them respects the privacy
contract: no transcript content, no raw file paths beyond the user's own Model cache,
no credentials.

## Non-Goals

- None of these commands download the Engine or models; `kesha doctor` and
  `kesha status` are read-only even if the Engine is missing.
- The Stats DB records anonymous performance metrics only; it never records
  transcript text, audio bytes, input file names, or full paths.
- `kesha support-bundle` does not upload anything; it writes a local `.tar.gz` that
  the user attaches manually.

## Requirements

### Requirement: `kesha doctor` produces a read-only diagnostic report

`kesha doctor` SHALL collect and print a structured diagnostic report covering: CLI
package name and version; Bun runtime version, platform, and architecture; Engine
binary path, install status, version marker, and Capabilities JSON (obtained by
probing the Engine); Model cache path, existence, total size, and per-component
breakdown; optional-component install status (VAD, TTS Kokoro, TTS Vosk, FluidAudio
Kokoro cache, Diarization, Sidecars); Stats DB status; Diagnostic log status; and a
snapshot of known `KESHA_*` environment variables.

`kesha doctor` SHALL always exit 0, even when components are missing or the Engine
probe fails. It SHALL never download or modify any file.

`--json` outputs the same data as 2-space-indented JSON to stdout.

`--redact` replaces secret-pattern key values (keys containing TOKEN, KEY, SECRET,
PASSWORD, CREDENTIAL, or AUTH) with `[REDACTED]`, rewrites home-directory path
prefixes to `~`, and strips URL credentials and query strings. Redaction is opt-in
for `kesha doctor`; it is always-on for `kesha support-bundle`.

#### Scenario: Ira probes a broken CI image

- GIVEN the Engine binary is missing
- WHEN Ira runs `kesha doctor`
- THEN the report shows `Binary: <path> (missing)` and `not available` for
  capabilities
- AND all other sections are still present
- AND the process exits 0

#### Scenario: Maks checks a healthy install in JSON

- GIVEN the Engine and ASR models are installed
- WHEN Maks runs `kesha doctor --json`
- THEN stdout is a JSON object with `package`, `runtime`, `engine`, `cache`,
  `optionalComponents`, `stats`, `diagnosticLogs`, and `env` keys
- AND the process exits 0

#### Scenario: Sona redacts before sharing

- GIVEN `KESHA_MODEL_MIRROR=https://user:pass@mirror.example.com/models` is set
- WHEN Sona runs `kesha doctor --redact`
- THEN the mirror value in the env snapshot is printed as
  `https://mirror.example.com/models` (credentials stripped)
- AND home-directory paths appear as `~/…`
- AND the process exits 0

> *Technical Note — sources: `src/doctor.ts::collectDoctorReport`,
> `src/doctor.ts::formatDoctorReport`, `src/cli/doctor.ts::doctorCommand`.
> Known env keys snapshot: `KESHA_ENGINE_BIN`, `KESHA_CACHE_DIR`,
> `KESHA_MODEL_MIRROR`, `KESHA_STATS_DB`, `KESHA_DEBUG`, `KESHA_DEBUG_FD`
> (from `KNOWN_ENV_KEYS`). Secret-pattern detection splits the key on
> non-alphanumeric characters and checks each part against
> `["TOKEN","KEY","SECRET","PASSWORD","CREDENTIAL","AUTH"]`. URL redaction strips
> `username`, `password`, `search`, and `hash`. Home-path redaction rewrites the
> exact home prefix to `~`; case-insensitive on Windows.*

### Requirement: `kesha status` shows engine and voice install state

`kesha status` SHALL print a concise install summary: Engine binary path and install
status; Backend, protocol version, and features (from Capabilities JSON); Bun runtime
version and platform; active Model mirror (when `KESHA_MODEL_MIRROR` is set); and the
list of installed TTS Voice ids.

`--disk` SHALL additionally print a per-component disk-usage table (Engine, ASR,
Language ID, VAD, TTS Kokoro, TTS Vosk) and the grand total. The FluidAudio Kokoro
external cache is reported separately when it exists, because it lives outside
Kesha's Model cache.

When the Engine is not installed, `kesha status` prints an actionable setup hint
(`kesha init` on an interactive TTY, `kesha install` when stderr is piped) and
exits 0.

#### Scenario: Ira checks install state in a script

- GIVEN the Engine and ASR models are installed with TTS English
- WHEN Ira runs `kesha status`
- THEN the output shows a green check for the Engine binary and its backend
- AND lists `en-am_michael` (and other installed Kokoro voices) under TTS voices
- AND the process exits 0

#### Scenario: Maks sees disk usage

- WHEN Maks runs `kesha status --disk`
- THEN a disk-usage table appears with per-component sizes and a bold Total
- AND if FluidAudio Kokoro cache exists it is listed under "External caches"

#### Scenario: Engine missing

- GIVEN no Engine is installed
- WHEN Ira runs `kesha status`
- THEN the output shows a red cross for the Engine binary
- AND an actionable setup hint is printed — `kesha init` on an interactive TTY,
  `kesha install` when stderr is piped (`installHint()`, `src/status.ts:86`)
- AND the process exits 0

> *Technical Note — sources: `src/status.ts::showStatus`, `src/status.ts::showDiskUsage`,
> `src/cli/status.ts::statusCommand`. TTS voice enumeration reads `kokoro-82m/voices/*.bin`
> (prefixed `en-`) and checks `vosk-ru/model.onnx` + `vosk-ru/bert/model.onnx` presence
> (voices `ru-vosk-f01`, `ru-vosk-f02`, `ru-vosk-f03`, `ru-vosk-m01`, `ru-vosk-m02`).
> `activeModelMirror()` trims and strips trailing slashes from `KESHA_MODEL_MIRROR`;
> returns null when unset or empty.*

### Requirement: `kesha logs` manages privacy-safe NDJSON Diagnostic logs

`kesha logs` SHALL manage the local NDJSON Diagnostic log with the following actions:
`status` (default), `enable`, `disable`, `mode <off|on|retain-on-failure>`, `path`,
and `reset`.

The three log modes are:
- **off**: no events are written.
- **on**: events are appended to the active log file immediately.
- **retain-on-failure**: events are buffered in memory per CLI session and flushed to
  disk only if the session ends with status `failed`; on success the buffer is
  discarded.

The default mode is `retain-on-failure`.

`--json` is only valid with the `status` action; combining it with any other action
SHALL exit 2.

The Diagnostic log allowlist enforces privacy at write time: field names matching
path, file, filename, message, text, transcript, stdout, stderr, env, token, secret,
password, key, url, prompt, content, or raw are rejected; string values containing
path separators, file extensions, domain names, or URL schemes are rejected. Events
are NDJSON lines with fixed fields `ts`, `level`, `event`, `app_version`, `pid`.

Log files rotate when the active file would exceed `maxBytes` (default 10 MB); up to
`retain` rotated files are kept (default 5). Rotation naming: `kesha.1.ndjson`,
`kesha.2.ndjson`, etc.

Log directory: `~/Library/Logs/kesha` (macOS), `%LOCALAPPDATA%\kesha\logs` (Windows),
`$XDG_STATE_HOME/kesha/logs` (Linux; override: `KESHA_LOG_DIR`).

#### Scenario: Ira checks log status

- WHEN Ira runs `kesha logs status`
- THEN the mode, active path, total size, rotated file count, and rotation settings
  are printed to stderr/info
- AND the process exits 0

#### Scenario: Enable and then disable

- WHEN Ira runs `kesha logs enable` then `kesha logs disable`
- THEN after `enable` the mode is `on` and the path is reported
- AND after `disable` the mode is `off`
- AND both commands exit 0

#### Scenario: `--json` with non-status action is rejected

- WHEN Ira runs `kesha logs enable --json`
- THEN the CLI prints `usage: kesha logs status --json` to stderr
- AND exits 2

#### Scenario: Invalid mode value is rejected

- WHEN Ira runs `kesha logs mode always`
- THEN the CLI prints `usage: kesha logs mode <off|on|retain-on-failure>` to stderr
- AND exits 2

#### Scenario: `reset` deletes log files

- GIVEN two rotated log files exist alongside the active log
- WHEN Maks runs `kesha logs reset`
- THEN all log files are deleted
- AND the output reports the number of files and bytes deleted
- AND the process exits 0

> *Technical Note — sources: `src/diagnostic-log.ts`, `src/cli/logs.ts::logsCommand`.
> Active log file: `kesha.ndjson`. Rotated files match `/^kesha\.\d+\.ndjson$/`.
> Field name blocklist: `DISALLOWED_FIELD_NAME` regex; string value safety:
> `SAFE_STRING_VALUE = /^[A-Za-z0-9_.@+-]{1,120}$/` AND NOT `UNSAFE_STRING_VALUE`
> (path separators, file extensions, domain-like patterns, URL schemes).
> Reserved field names: `ts`, `level`, `event`, `app_version`, `pid`.*

### Requirement: `kesha stats` manages local anonymous SQLite metrics

`kesha stats` SHALL manage the local SQLite Stats DB with the following actions:
`status` (default), `enable`, `disable`, `week`, `errors`, `export`, `reset`,
`vacuum`, and `retention`.

Stats are disabled by default (the DB is not created until `kesha stats enable` is
called). The Stats DB records command name, timing stages, artifact metadata
(format, size in bytes, duration, sample rate, channels), and sanitized error
messages — never transcript text, audio bytes, input file names, or raw paths.

`export` requires a format argument: `json` or `csv`; any other value or omitting
the format SHALL exit 2. `retention <days>` accepts a positive integer of days or
`off` for no expiry; any other value SHALL exit 2. Unknown action names SHALL exit 2.

Default retention is 90 days. The DB path defaults to
`~/Library/Application Support/kesha/stats.sqlite` (macOS),
`%APPDATA%\kesha\stats.sqlite` (Windows), or
`$XDG_DATA_HOME/kesha/stats.sqlite` (Linux); override: `KESHA_STATS_DB`.

#### Scenario: Ira checks stats status when disabled

- GIVEN `kesha stats enable` has never been run
- WHEN Ira runs `kesha stats status`
- THEN the output shows `Kesha Stats: disabled` and `Runs: 0`
- AND the process exits 0

#### Scenario: Maks enables stats and checks the week summary

- WHEN Maks runs `kesha stats enable`
- THEN the output shows `Kesha Stats enabled` and the DB path
- AND `kesha stats week` then shows the last-7-days summary including runs, input
  files, STT time, and stage breakdown
- AND both commands exit 0

#### Scenario: Export with missing format is rejected

- WHEN Ira runs `kesha stats export`
- THEN the CLI prints `usage: kesha stats export --format json|csv` to stderr
- AND exits 2

#### Scenario: Invalid retention value is rejected

- WHEN Ira runs `kesha stats retention 0`
- THEN the CLI prints `usage: kesha stats retention <days|off>` to stderr
- AND exits 2

#### Scenario: Unknown action is rejected

- WHEN Ira runs `kesha stats purge`
- THEN the CLI lists supported actions to stderr
- AND exits 2

> *Technical Note — sources: `src/stats.ts`, `src/cli/stats.ts::statsCommand`.
> Stats DB schema v1: tables `settings`, `runs`, `artifacts`, `stage_timings`,
> `errors`. Privacy contract (in every export): `contentFree: true`,
> `neverStored: ["audio bytes","transcripts","input text","output text","file names",
> "full file paths","raw stdout","raw stderr","environment variables","model files"]`.
> Error sanitization: strips stack frames, replaces home/cwd paths with `<path>`,
> redacts URL query strings, redacts JSON text/transcript/stdout/stderr field values,
> truncates to 300 chars. `export` writes to stdout (not stderr). `vacuum` runs
> `pragma wal_checkpoint(TRUNCATE)` then `vacuum`.*

### Requirement: `kesha support-bundle` creates a redacted diagnostics archive

`kesha support-bundle` SHALL write a `.tar.gz` archive containing:
- `README.txt` — description and privacy notice
- `doctor.json` — redacted JSON doctor report
- `doctor.txt` — redacted human-readable doctor report
- `manifest.json` — archive metadata (entries, generation time, package, format)

When `--include-logs` is passed, three additional entries are added under
`diagnostic-logs/`: `README.txt`, `kesha.ndjson` (a bounded tail of the active log,
default 64 KB), and `status.json`.

The archive SHALL never contain audio files, transcripts, model files, the Stats DB,
or any file not in the list above. Redaction is always-on (equivalent to
`kesha doctor --redact`).

`--output <path>` sets the archive path; the default is
`kesha-support-bundle-<ISO-timestamp>.tar.gz` in the current directory.

On success the CLI reports the archive path, entry count, and size in bytes to stderr.
On failure it exits 1 with the error message.

#### Scenario: Sona creates a bundle for a GitHub issue

- GIVEN the Engine is installed and logs exist
- WHEN Sona runs `kesha support-bundle`
- THEN a `.tar.gz` is written in the current directory
- AND the output shows the path, `Entries: 4`, and the file size
- AND the archive contains `README.txt`, `doctor.json`, `doctor.txt`,
  `manifest.json`
- AND the process exits 0

#### Scenario: Ira includes logs for a failing install report

- WHEN Ira runs `kesha support-bundle --include-logs`
- THEN the archive contains 7 entries including `diagnostic-logs/kesha.ndjson`
- AND the log tail is bounded (≤64 KB by default)
- AND the process exits 0

#### Scenario: Custom output path

- WHEN Maks runs `kesha support-bundle --output /tmp/kesha-diag.tar.gz`
- THEN the archive is written to `/tmp/kesha-diag.tar.gz`
- AND the success message includes that exact path

> *Technical Note — sources: `src/support-bundle.ts::createSupportBundle`,
> `src/cli/support-bundle.ts::supportBundleCommand`. Redaction is always applied
> (`redact: true` is hardcoded in `createSupportBundle`; the `--redact` flag exists
> on `kesha doctor` but not `kesha support-bundle`). Log tail default:
> `DEFAULT_TAIL_BYTES = 64 * 1024` from `src/diagnostic-log.ts`. The tar format is
> a hand-written ustar implementation (no external dependency); archives are
> gzip-compressed with Node's `zlib.gzipSync`. The manifest `entries` array lists
> bare entry names (without the archive root prefix).*

### Requirement: Privacy framing — redaction, allowlists, and size-bucketing are always enforced

Across all diagnostic commands, the CLI SHALL enforce the following privacy boundaries
as invariants, not options:

1. Diagnostic log field names and values are validated against an allowlist at write
   time; invalid fields cause the event to be dropped, not silently truncated.
2. Stats error messages have home and cwd paths replaced with `<path>`, URL query
   strings redacted, and content-bearing JSON fields redacted before storage;
   messages are truncated to 300 characters.
3. Stats artifact records store audio size in bytes and duration — never file names,
   full paths, or content.
4. Support bundles are always redacted and never include audio, transcripts, model
   files, or the Stats DB, regardless of flags.

#### Scenario: Diagnostic log rejects a path-like field value

- GIVEN the Diagnostic log mode is `on`
- WHEN a CLI command attempts to log an event with a field value containing `/tmp/audio.wav`
- THEN the event is dropped (logged to debug only) and no NDJSON line is written
- AND the command continues normally

#### Scenario: Stats export privacy contract is present in every export

- GIVEN stats are enabled and some runs are recorded
- WHEN Ira runs `kesha stats export --format json`
- THEN the JSON output contains a `privacy` key with `contentFree: true` and
  a `neverStored` array
- AND no transcript or file-path data appears anywhere in the export

> *Technical Note — sources: `src/diagnostic-log.ts` (`DISALLOWED_FIELD_NAME`,
> `UNSAFE_STRING_VALUE`, `SAFE_STRING_VALUE`, `validateField`);
> `src/stats.ts::sanitizeStatsError`, `src/stats.ts::statsPrivacyContract`,
> `src/stats.ts::artifactFromFile` (records `extname(path)` and `st.size`, not the
> path itself). Audio size bucketing in `stats.ts::summarizeSizeBuckets`:
> `<1 MB`, `1-10 MB`, `10-100 MB`, `100 MB+`.*

## Open Issues

- `kesha doctor` does not surface the FluidAudio Kokoro external cache size in the
  plain-text format (it is included in the JSON and in the cache components list, but
  the human-readable section omits it); the `--disk` flag on `kesha status` does show
  it correctly.
- `kesha logs` has no `tail` or `cat` action for reading log contents from the CLI;
  the only way to include log contents is via `kesha support-bundle --include-logs`.
- `kesha stats` has no `--json` flag on `status`; machine-readable stats output
  requires `export --format json`.
