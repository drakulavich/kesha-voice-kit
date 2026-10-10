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

`kesha doctor` SHALL collect and print a structured diagnostic report, SHALL always
exit 0, even when components are missing or the Engine probe fails, and SHALL never
download or modify any file. `--json` outputs the same data as 2-space-indented JSON
to stdout.

#### Scenario: Ira probes a broken CI image

- GIVEN the Engine binary is missing
- WHEN Ira runs `kesha doctor`
- THEN the report shows `Binary: <path> (missing)` and `not available` for
  the describe document
- AND all other sections are still present
- AND the process exits 0

#### Scenario: Maks checks a healthy install in JSON

- GIVEN the Engine and ASR models are installed
- WHEN Maks runs `kesha doctor --json`
- THEN stdout is a JSON object with `package`, `runtime`, `engine`, `cache`,
  `optionalComponents`, `stats`, `diagnosticLogs`, `env`, and `paths` keys
- AND the process exits 0

#### Scenario: Maks checks an install an interrupted download left behind

- GIVEN the `say-avspeech` sidecar file exists but is truncated
- WHEN Maks runs `kesha doctor`
- THEN the report shows it as installed but not executable, with a `kesha install` hint
- AND a sidecar that is simply absent is still shown as missing
- AND the process exits 0

#### Scenario: Ira verifies that an isolated run touched nothing of hers

- GIVEN `KESHA_HOME=/tmp/kesha-ci` is set
- WHEN Ira runs `kesha doctor --json`
- THEN `paths.cache`, `paths.logs`, `paths.stats` and `paths.mcpAudio` all point under
  `/tmp/kesha-ci` with `source: "KESHA_HOME"`
- AND `env` lists `KESHA_HOME` with its value
- AND the process exits 0

#### Scenario: Sona redacts before sharing

- GIVEN `KESHA_MODEL_MIRROR=https://user:pass@mirror.example.com/models` is set
- WHEN Sona runs `kesha doctor --redact`
- THEN the mirror value in the env snapshot is printed as
  `https://mirror.example.com/models` (credentials stripped)
- AND home-directory paths appear as `~/…`
- AND the process exits 0

#### Scenario: The env snapshot no longer offers a descriptor variable

- GIVEN `KESHA_DEBUG_FD=7` is exported from an old script
- WHEN Maks runs `kesha doctor`
- THEN the env snapshot does not list `KESHA_DEBUG_FD`, because the variable no longer exists
- AND the process exits 0

#### Scenario: Doctor names the languages a Kokoro cache cannot serve

- GIVEN darwin-arm64 with the English ANE chain staged and no Spanish pack
- WHEN Sona runs `kesha doctor --json`
- THEN the FluidAudio Kokoro component lists `en` as staged and `es` among the missing languages
- AND the report carries the installed Voice ids

> *Technical Note — sources: `src/doctor.ts::collectDoctorReport`,
> `src/doctor.ts::formatDoctorReport`, `src/cli/doctor.ts::doctorCommand`.
> Executability comes from `src/engine-health.ts::probeExecutable` and surfaces as
> `engine.runnable` and per-component `runnable` in the JSON report; any exit code counts
> as healthy, since the sidecars legitimately exit non-zero when given no work.
> Known env keys snapshot: the eleven entries of `src/doctor.ts::KNOWN_ENV_KEYS`
> (`KESHA_HOME`, `KESHA_ENGINE_BIN`, `KESHA_CACHE_DIR`, `KESHA_MODEL_MIRROR`, `KESHA_STATS_DB`,
> `KESHA_DEBUG`, the two `*_COMPUTE_UNITS`, the two diarize timeouts and
> `KESHA_INSTALL_LOCK_WAIT_SECS`); `KESHA_DEBUG_FD` is no longer among them. Secret-pattern
> detection splits the key on non-alphanumeric characters and checks each part against
> `["TOKEN","KEY","SECRET","PASSWORD","CREDENTIAL","AUTH"]`. URL redaction strips
> `username`, `password`, `search`, and `hash`. Home-path redaction rewrites the
> exact home prefix to `~`; case-insensitive on Windows. The `paths` object comes from
> `src/state-paths.ts::resolveStatePaths`; its path values and the `KESHA_HOME` value in the
> env snapshot pass through that same home-prefix redaction.*

### Requirement: The `kesha doctor` report covers every part of an install

The `kesha doctor` report SHALL cover: CLI package name and version; Bun version,
platform and architecture; Engine binary path, install status, version marker and
describe document; Model cache path, existence, total size and per-component
breakdown; install status of VAD, TTS Kokoro, TTS Vosk, the FluidAudio Kokoro cache,
Diarization and Sidecars; staged TTS languages and installed Voice ids; Stats DB and Diagnostic log status; and the known `KESHA_*`
environment variables.

#### Scenario: Maks reads every section of a healthy report

- GIVEN the Engine, ASR models and TTS English are installed
- WHEN Maks runs `kesha doctor`
- THEN the report shows the package, runtime, Engine with its version marker and
  describe document, Model cache with per-component sizes, optional components, TTS
  languages and Voice ids, Stats DB, Diagnostic log and environment sections
- AND the process exits 0

#### Scenario: Ira's fresh image has no optional component

- GIVEN only the Engine and ASR models are installed
- WHEN Ira runs `kesha doctor`
- THEN VAD, TTS Kokoro, TTS Vosk, Diarization and each Sidecar are still listed, each
  shown as `missing`
- AND the process exits 0

> *Technical Note — the describe document is obtained by probing the Engine.
> Sources: `src/doctor.ts::collectDoctorReport` assembles the sections; optional components come from `src/doctor.ts::collectOptionalComponents`,
> which always returns every entry and lets `formatComponentState` print `missing`.*

### Requirement: `kesha doctor` names where each kind of state lives

The `kesha doctor` report SHALL name the four resolved state paths (Model cache,
Diagnostic log directory, Stats DB, MCP audio directory), each with the source that
decided it (`default`, `KESHA_HOME`, or the specific variable), as defined by
`state-directories`.

#### Scenario: Maks runs doctor with nothing overridden

- GIVEN no `KESHA_*` state variable is set
- WHEN Maks runs `kesha doctor --json`
- THEN `paths.cache`, `paths.logs`, `paths.stats` and `paths.mcpAudio` each carry a
  path and `source: "default"`

#### Scenario: Only the log directory is overridden

- GIVEN `KESHA_LOG_DIR=/var/log/kesha` is set and `KESHA_HOME` is not
- WHEN Maks runs `kesha doctor --json`
- THEN `paths.logs` is `/var/log/kesha` with `source: "KESHA_LOG_DIR"`
- AND the other three paths keep `source: "default"`

> *Technical Note — sources: `src/doctor.ts::collectPaths`, over the same
> `src/state-paths.ts::resolveStatePaths` result `kesha status` uses.*

### Requirement: Doctor reports FluidAudio Kokoro completeness per language

The FluidAudio Kokoro component in the `kesha doctor` report SHALL report
completeness per language: a language whose voice pack is absent is listed as missing
for that language, and the component SHALL NOT report an empty `missing` list while
a supported language cannot be synthesized from it.

#### Scenario: Every supported language is staged

- GIVEN darwin-arm64 with the FluidAudio Kokoro voice pack staged for every
  supported language
- WHEN Sona runs `kesha doctor`
- THEN the TTS section reads `Languages missing a voice pack: none`

#### Scenario: A voice pack is missing from an otherwise staged cache

- GIVEN darwin-arm64 with the English ANE chain staged and no Spanish pack
- WHEN Sona runs `kesha doctor`
- THEN the FluidAudio Kokoro component reads as incomplete, naming `es`, with a
  `kesha install --tts` hint
- AND the process exits 0

> *Technical Note — sources: `src/doctor.ts::collectTts` and the
> `kokoroAneComponents` entries in `collectOptionalComponents`; the incomplete line is
> `src/doctor.ts::formatComponentState`.*

### Requirement: Doctor tells a corrupt binary from a missing one

`kesha doctor` SHALL establish install status for the Engine binary and the Sidecars
by running them, not by testing that the file exists. A binary that is present but
which the OS refuses to execute SHALL be reported as corrupt with a reinstall hint,
distinctly from one that is not installed.

#### Scenario: A Sidecar that runs is reported installed

- GIVEN `kesha-textlang` sits beside the Engine and exits non-zero when given no work
- WHEN Maks runs `kesha doctor --json`
- THEN that component reports `runnable: true`, because any exit code counts as
  running

#### Scenario: The Engine binary is present but cannot execute

- GIVEN the Engine binary exists but the OS refuses to execute it
- WHEN Ira runs `kesha doctor`
- THEN the Engine is reported as corrupt with a reinstall hint, not as missing
- AND `engine.runnable` is `false` in `--json` output
- AND the process exits 0

> *Technical Note — sources: `src/engine-health.ts::probeExecutable`;
> `src/doctor.ts::sidecarComponent` and `formatEngineBinaryState`/`formatComponentState`
> map a failed probe to the corrupt state.*

### Requirement: `kesha doctor --redact` strips secrets before a report is shared

`kesha doctor --redact` SHALL replace the values of secret-pattern keys (keys
containing TOKEN, KEY, SECRET, PASSWORD, CREDENTIAL, or AUTH) with `[REDACTED]`,
rewrite home-directory path prefixes to `~`, and strip URL credentials and query
strings. Redaction SHALL be opt-in for `kesha doctor` and always on for
`kesha support-bundle`.

#### Scenario: Sona redacts a mirror URL carrying a signed query

- GIVEN `KESHA_MODEL_MIRROR=https://mirror.example.com/models?sig=abc` is set
- WHEN Sona runs `kesha doctor --redact`
- THEN the env snapshot shows `https://mirror.example.com/models`
- AND the process exits 0

#### Scenario: Maks runs doctor without the flag

- GIVEN `KESHA_HOME` points under Maks's home directory
- WHEN Maks runs `kesha doctor` without `--redact`
- THEN the paths print in full, with no `~` rewrite and no `[REDACTED]` value

> *Technical Note — sources: `src/doctor.ts::isSecretKey`, `redactUrl` and
> `redactHomePaths`, applied only when the `redact` option is set;
> `src/support-bundle.ts::createSupportBundle` hardcodes it.*

### Requirement: `kesha status` shows engine and voice install state

`kesha status` SHALL print a concise install summary: Engine binary path and install
status; Backend, protocol version, and features (from the describe document); Bun runtime
version and platform; active Model mirror (when `KESHA_MODEL_MIRROR` is set); and the
list of installed TTS Voice ids. When the Engine is not installed, it SHALL print an
actionable setup hint (`kesha init` on an interactive TTY, `kesha install` when stderr
is piped) and exit 0.

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

#### Scenario: Ira's engine lives under /usr/local

- GIVEN `KESHA_ENGINE_BIN=/usr/local/bin/kesha-engine`
- WHEN she runs `kesha status --disk` or `kesha doctor`
- THEN the Engine row reports that binary plus any Sidecar next to it
- AND nothing else under `/usr/local` is walked or counted in the cache total

#### Scenario: Engine missing

- GIVEN no Engine is installed
- WHEN Ira runs `kesha status`
- THEN the output shows a red cross for the Engine binary
- AND an actionable setup hint is printed — `kesha init` on an interactive TTY,
  `kesha install` when stderr is piped (`installHint()`, `src/status.ts::engineHint`)
- AND the process exits 0

#### Scenario: Ira asks for disk usage with no Engine installed

- GIVEN no Engine is installed
- WHEN Ira runs `kesha status --json --disk`
- THEN the disk breakdown is reported as null and the Model cache is not walked
- AND the process exits 0

#### Scenario: Ira branches on install state without parsing prose

- GIVEN the Engine is installed
- WHEN Ira runs `kesha status --json`
- THEN stdout parses as a single JSON object and contains nothing else
- AND the object reports Engine presence as `true`, the binary path, the Backend,
  the protocol version `4`, the features, and the installed TTS Voice ids
- AND the process exits 0

#### Scenario: Maks sees where a second profile writes

- GIVEN `KESHA_HOME=/Volumes/work/kesha` and `KESHA_LOG_DIR=/var/log/kesha` are set
- WHEN Maks runs `kesha status --json`
- THEN `paths.cache.source` is `"KESHA_HOME"` and `paths.logs.source` is `"KESHA_LOG_DIR"`
- AND `paths.logs.path` is `/var/log/kesha`
- AND with neither variable set every `source` reads `"default"` and no key is omitted

#### Scenario: Engine missing under `--json`

- GIVEN no Engine is installed
- WHEN Ira runs `kesha status --json`
- THEN the object reports Engine presence as `false` and carries the same
  actionable setup hint the human path writes to stderr
- AND stderr does not repeat that hint
- AND the process exits 0

#### Scenario: The describe probe fails under `--json`

- GIVEN the Engine binary exists but `kesha-engine describe` cannot be read
  (corrupt or incompatible binary)
- WHEN Ira runs `kesha status --json`
- THEN Engine presence is reported as `true` while the capabilities value is null
  rather than omitted or guessed
- AND a consumer reading presence together with the null capabilities can tell
  this apart from both a healthy Engine and a missing one
- AND the process exits 0, matching the human path's "probe failed" line

#### Scenario: Status agrees with --list-voices

- GIVEN an installed Engine on darwin-arm64
- WHEN Maks compares `kesha status --json | jq '.voices | length'` with `kesha say --list-voices | wc -l`
- THEN the two numbers are equal

#### Scenario: Status without an Engine still lists what is on disk

- GIVEN no Engine binary but Vosk-TTS files in the Model cache
- WHEN Ira runs `kesha status`
- THEN the five `ru-vosk-*` ids are listed from the cache and the setup hint is printed

> *Technical Note — sources: `src/status.ts::collectStatus` and `renderStatus`, `src/status.ts::showDiskUsage`,
> `src/cli/status.ts::statusCommand`. TTS voice enumeration is
> `src/voice-inventory.ts::installedVoiceIds`: `kesha-engine say --list-voices` when the
> Engine is installed, otherwise (or when that probe fails) `cachedVoiceIds`, which reads
> `kokoro-82m/voices/*.bin` (prefixed `en-`) and checks the Vosk-RU files' presence
> (voices `ru-vosk-f01`, `ru-vosk-f02`, `ru-vosk-f03`, `ru-vosk-m01`, `ru-vosk-m02`).
> `activeModelMirror()` trims and strips trailing slashes from `KESHA_MODEL_MIRROR`;
> returns null when unset or empty. Capabilities are `engineFunctionalHealth()`'s
> (`src/engine-health.ts`) `capabilities` when its status is `ok` and null otherwise, so a
> failed or unparseable probe is what the payload reports as null. The `paths` object is
> `src/state-paths.ts::resolveStatePaths` rendered as-is. The `--json`
> flag follows the `doctor` precedent at `src/cli/doctor.ts::doctorCommand`. The
> Raycast extension reads the nested value at
> `raycast/src/lib/kesha-bin.ts::readStructuredStatus`.*

### Requirement: `kesha status` lists the Engine's own Voice inventory

When an Engine is installed and answers, the Voice ids `kesha status` lists SHALL be
the Engine's own inventory (the same list `kesha say --list-voices` prints, including
FluidAudio Kokoro voices and `macos-*` system voices); when no Engine is installed or
its inventory probe fails, the list SHALL fall back to what the Model cache holds on
disk.

#### Scenario: Maks lists voices on Linux with Kokoro installed

- GIVEN an installed Engine on linux-x64 with TTS English staged
- WHEN Maks runs `kesha status --json`
- THEN `voices` is exactly the list `kesha say --list-voices` prints
- AND the process exits 0

#### Scenario: The inventory probe fails

- GIVEN the Engine binary exists but `kesha-engine say --list-voices` fails
- WHEN Ira runs `kesha status`
- THEN the Voice ids are read from the Model cache instead
- AND the process exits 0

> *Technical Note — sources: `src/voice-inventory.ts::installedVoiceIds`, falling back
> to `cachedVoiceIds`; called from `src/status.ts::collectStatus`.*

### Requirement: `kesha status --disk` reports disk usage per component

`kesha status --disk` SHALL additionally print a per-component disk-usage table
(Engine, ASR, Language ID, VAD, TTS Kokoro, TTS Vosk) and the grand total, and SHALL
report the FluidAudio Kokoro external cache separately when it exists.

#### Scenario: Maks checks usage after a full install

- GIVEN the Engine, ASR, Language ID, VAD and TTS models are installed
- WHEN Maks runs `kesha status --disk`
- THEN each component has its own row with a size, followed by the grand total
- AND the process exits 0

#### Scenario: No FluidAudio Kokoro cache exists

- GIVEN a linux-x64 install, where no FluidAudio Kokoro cache is ever created
- WHEN Maks runs `kesha status --disk`
- THEN no "External caches" section is printed
- AND the grand total equals the component total

> *Technical Note — the FluidAudio Kokoro cache is reported apart because it lives
> outside Kesha's Model cache. Sources: `src/status.ts::showDiskUsage` and
> `collectDiskUsage`; rows come from `src/cache-layout.ts::cacheComponents`, external
> roots from `fluidExternalRoots`.*

### Requirement: The Engine row sizes only what Kesha owns

The Engine row SHALL size only what Kesha owns, in `kesha status --disk` and in
`kesha doctor`'s cache components: the whole `<Model cache>/engine` directory for a
managed install (the binary at `<Model cache>/engine/bin/`), and otherwise the binary
itself plus the Sidecars beside it (`say-avspeech`, `kesha-textlang`). Neither command
SHALL walk the binary's parent or grandparent directory, nor any directory reached
through those names.

#### Scenario: A managed install is counted once

- GIVEN the Engine binary lives at `<Model cache>/engine/bin/kesha-engine`
- WHEN Maks runs `kesha status --disk`
- THEN the Engine row's path is `<Model cache>/engine` and its size covers that
  whole directory
- AND the cache total counts those bytes once, because they already lie inside the
  Model cache

#### Scenario: A Nix-store Engine with a directory where a Sidecar would be

- GIVEN `KESHA_ENGINE_BIN` points at a read-only Nix store binary outside the Model
  cache, and a `kesha-textlang` entry beside it is a directory
- WHEN Ira runs `kesha doctor`
- THEN the Engine row's path is the binary itself and its size is the binary plus
  `say-avspeech`, with the `kesha-textlang` directory counted as zero
- AND the cache total adds the Engine bytes, since they lie outside the Model cache

> *Technical Note — a Sidecar counts only when it is (or links to) a regular file. The
> JSON shape is the same as before the row was narrowed. Sources:
> `src/cache-layout.ts::engineFootprint`, `regularFileBytes` and `cacheTotalBytes`
> (#1313, #790).*

### Requirement: `kesha status --json` prints one machine-readable object

`kesha status --json` SHALL replace the human-readable rendering with a single JSON
object on stdout and print nothing else there. The object SHALL report at least:
Engine presence as a boolean, the resolved Engine binary path, Backend, protocol
version and features, the installed TTS Voice ids, the Bun runtime version, platform
and architecture, the active Model mirror, the CLI version, and, when the Engine is
absent, the setup hint the human path writes to stderr.

#### Scenario: Maks parses a healthy payload

- GIVEN the Engine is installed
- WHEN Maks runs `kesha status --json | jq .cliVersion`
- THEN the CLI version prints, and stdout held nothing but that one object
- AND the process exits 0

#### Scenario: No mirror is set and no voice is installed

- GIVEN `KESHA_MODEL_MIRROR` is unset and no TTS voice is installed
- WHEN Maks runs `kesha status --json`
- THEN `modelMirror` is `null` and `voices` is `[]`, and both keys are present, as
  every documented key is in every payload

### Requirement: Every documented `kesha status --json` key is present in every payload

Every documented key SHALL be present in every `kesha status --json` payload: an absent value SHALL be `null`, or the empty list for Voice ids, and SHALL never be omitted.

#### Scenario: Ira reads the payload on a runner with no Engine

- GIVEN no Engine is installed and no voices are cached
- WHEN Ira runs `kesha status --json`
- THEN `engine.installed` is `false`, `engine.capabilities` and `disk` are present
  with `null` values, and `voices` is `[]`

#### Scenario: A consumer checks for a key by name

- GIVEN any install state
- WHEN Sona's script tests `has("modelMirror")` on the payload
- THEN it is `true`, because no documented key is ever dropped

> *Technical Note — every key is always present so a consumer never has to tell a
> missing key apart from a null value; the CLI version lets a consumer that needs to
> distinguish payload shapes key off it without a second invocation. Source:
> `src/status.ts::StatusReport` and `collectStatus`.*

### Requirement: `kesha status --json` makes "can the Engine run" one check

The `kesha status --json` presence boolean SHALL report only that the Engine binary
exists, not that it is usable. Backend, protocol version and features SHALL be
grouped under one nested capabilities value, null when the binary cannot report
them, so consumers SHALL decide that the Engine can run from presence AND non-null
capabilities, without matching human-readable prose. The nested value's shape and key
name SHALL NOT change with protocol version 4.

#### Scenario: Ira gates a job on a healthy Engine

- GIVEN the Engine is installed and its describe document reads cleanly
- WHEN Ira's script reads `engine.installed` and `engine.capabilities`
- THEN presence is `true` and capabilities carries the Backend, protocol version and
  features, so the script proceeds

#### Scenario: Ira gates a job on a missing Engine

- GIVEN no Engine is installed
- WHEN Ira's script reads the same two fields
- THEN presence is `false` and capabilities is `null`, so the script stops without
  parsing any prose

> *Technical Note — grouping makes a binary that cannot report yield one null rather
> than three. The nested value stays fixed so the Raycast extension keeps reading it
> unmodified (`raycast/src/lib/kesha-bin.ts::readStructuredStatus`).*

### Requirement: `kesha status --json` names where each kind of state lives

The `kesha status --json` object SHALL carry a `paths` object naming the resolved
Model cache, Diagnostic log directory, Stats DB and MCP audio directory, each with the
`source` that decided it (`default`, `KESHA_HOME`, or the specific variable).

#### Scenario: Ira confirms a CI run is isolated

- GIVEN `KESHA_HOME=/tmp/kesha-ci` is set
- WHEN Ira runs `kesha status --json`
- THEN every `paths.*.source` reads `"KESHA_HOME"` and every path lies under
  `/tmp/kesha-ci`

#### Scenario: Maks reads the human rendering with nothing overridden

- GIVEN no `KESHA_*` state variable is set
- WHEN Maks runs `kesha status`
- THEN no state path is printed with a source, because the human rendering prints a
  source only when it is not `default`

> *Technical Note — the `paths` object lets a consumer confirm isolation without
> reading timestamps. Sources: `src/status.ts::collectStatusPaths`; the human lines
> are printed in `src/status.ts::renderStatus`.*

### Requirement: `kesha status --json` keeps the human path's scope and exit code

Under `--json` the setup hint SHALL NOT also be written to stderr. `--json --disk`
SHALL include the per-component disk breakdown as structured data and plain `--json`
SHALL omit it; when the Engine is absent, `--json --disk` SHALL report the breakdown
as null without walking the Model cache. Both renderings SHALL come from one
collector, so they never disagree, and `--json` SHALL exit 0 whether or not the
Engine is installed.

#### Scenario: Maks asks for disk usage as JSON

- GIVEN the Engine is installed
- WHEN Maks runs `kesha status --json --disk`
- THEN `disk` carries the per-component rows and totals
- AND plain `kesha status --json` reports `disk` as `null`

#### Scenario: Ira pipes status with no Engine

- GIVEN no Engine is installed
- WHEN Ira runs `kesha status --json 2>err.txt`
- THEN the payload carries the setup hint and `err.txt` does not repeat it
- AND the process exits 0

> *Technical Note — the hint stays off stderr because the payload carries it; the
> disk breakdown follows the human flag's scope, and the human path computes disk usage
> only when the Engine is installed (#647). Source: `src/status.ts::collectStatus`
> feeds both `renderStatus` and the JSON writer.*

### Requirement: `kesha logs` manages privacy-safe NDJSON Diagnostic logs

`kesha logs` SHALL manage the local NDJSON Diagnostic log with the actions `status`
(default), `enable`, `disable`, `mode <off|on|retain-on-failure>`, `path`, and `reset`.
`--json` is only valid with the `status` action; combining it with any other action
SHALL exit 2.

#### Scenario: Ira checks log status

- WHEN Ira runs `kesha logs status`
- THEN the mode, active path, total size, rotated file count, and rotation settings
  are printed to stderr/info
- AND the process exits 0

#### Scenario: Ira's CI job keeps its logs out of her home directory

- GIVEN `KESHA_HOME=/tmp/kesha-ci` is set and `KESHA_LOG_DIR` is not
- WHEN Ira runs `kesha logs path`
- THEN the printed path is `/tmp/kesha-ci/logs/kesha.ndjson`
- AND `~/Library/Logs/kesha` is neither created nor written

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

> *Technical Note — sources: `src/diagnostic-log.ts`, `src/cli/logs.ts::logsCommand`;
> `src/diagnostic-log.ts::resolveDiagnosticLogDir` delegates to `src/state-paths.ts::resolveStatePaths`.
> Active log file: `kesha.ndjson`. Rotated files match `/^kesha\.\d+\.ndjson$/`.
> Field name blocklist: `DISALLOWED_FIELD_NAME` regex; string value safety:
> `SAFE_STRING_VALUE = /^[A-Za-z0-9_.@+-]{1,120}$/` AND NOT `UNSAFE_STRING_VALUE`
> (path separators, file extensions, domain-like patterns, URL schemes).
> Reserved field names: `ts`, `level`, `event`, `app_version`, `pid`.*

### Requirement: The Diagnostic log directory follows the state-directories precedence

The log directory SHALL be `KESHA_LOG_DIR` when set; otherwise `<KESHA_HOME>/logs`
when `KESHA_HOME` is set; otherwise `~/Library/Logs/kesha` (macOS),
`%LOCALAPPDATA%\kesha\logs` (Windows) or `$XDG_STATE_HOME/kesha/logs` (Linux), the
`state-directories` precedence.

#### Scenario: An explicit log directory wins

- GIVEN `KESHA_LOG_DIR=/var/log/kesha` and `KESHA_HOME=/tmp/kesha-ci` are both set
- WHEN Maks runs `kesha logs path`
- THEN the printed path is `/var/log/kesha/kesha.ndjson`

#### Scenario: Nothing is set on Linux

- GIVEN neither `KESHA_LOG_DIR` nor `KESHA_HOME` is set on linux-x64, and
  `XDG_STATE_HOME=/home/ira/.state`
- WHEN Ira runs `kesha logs path`
- THEN the printed path is `/home/ira/.state/kesha/logs/kesha.ndjson`

> *Technical Note — source: `src/diagnostic-log.ts::resolveDiagnosticLogDir`, which
> delegates to `src/state-paths.ts::resolveStatePaths`.*

### Requirement: Diagnostic log modes decide when events reach disk

The Diagnostic log SHALL support three modes and default to `retain-on-failure`:
**off** writes no events; **on** appends each event to the active log file
immediately; **retain-on-failure** buffers events in memory per CLI session and
flushes them to disk only if the session ends with status `failed`, discarding the
buffer on success.

#### Scenario: A failed run leaves its events behind

- GIVEN the mode is `retain-on-failure`
- WHEN Ira's transcription fails
- THEN the events buffered during that session are appended to the active log file

#### Scenario: A successful run leaves nothing

- GIVEN the mode is `retain-on-failure`
- WHEN Maks's transcription succeeds
- THEN no line is written to the Diagnostic log and the buffer is discarded

> *Technical Note — sources: `src/diagnostic-log.ts::createDiagnosticLogSession`
> (`event` buffers or appends; `finish` flushes only on `failed`).*

### Requirement: Diagnostic log events pass an allowlist at write time

The Diagnostic log SHALL enforce privacy at write time: field names matching path,
file, filename, message, text, transcript, stdout, stderr, env, token, secret,
password, key, url, prompt, content, or raw are rejected, and string values
containing path separators, file extensions, domain names, or URL schemes are
rejected. Each event SHALL be one NDJSON line with the fixed fields `ts`, `level`,
`event`, `app_version`, `pid`.

#### Scenario: A clean event is written with its fixed fields

- GIVEN the mode is `on`
- WHEN a command logs an event whose fields hold only short identifiers and numbers
- THEN one NDJSON line is appended carrying `ts`, `level`, `event`, `app_version`
  and `pid` alongside those fields

#### Scenario: A field named after content is rejected

- GIVEN the mode is `on`
- WHEN a command tries to log a field named `transcript`
- THEN that event is dropped and no NDJSON line is written

> *Technical Note — sources: `src/diagnostic-log.ts::buildDiagnosticLogLine` and
> `validateField`; a rejected field throws and the session's `event` drops the whole
> event with a debug message.*

### Requirement: Diagnostic log files rotate at a size cap

Diagnostic log files SHALL rotate when the active file would exceed `maxBytes`
(default 10 MB), keeping up to `retain` rotated files (default 5), named
`kesha.1.ndjson`, `kesha.2.ndjson` and so on.

#### Scenario: The active file reaches its cap

- GIVEN the active `kesha.ndjson` is one event short of `maxBytes`
- WHEN the next event would push it past the cap
- THEN the active file becomes `kesha.1.ndjson` and the event starts a new
  `kesha.ndjson`

#### Scenario: The rotated set is already full

- GIVEN `kesha.1.ndjson` through `kesha.5.ndjson` exist with the default `retain`
- WHEN the active file rotates again
- THEN the oldest, `kesha.5.ndjson`, is deleted and no more than five rotated files
  remain

> *Technical Note — source: `src/diagnostic-log.ts::rotateIfNeeded`.*

### Requirement: `kesha stats` manages local anonymous SQLite metrics

`kesha stats` SHALL manage the local SQLite Stats DB with the actions `status`
(default), `enable`, `disable`, `week`, `errors`, `export`, `reset`, `vacuum`, and
`retention`; unknown action names SHALL exit 2. `export` requires a format argument,
`json` or `csv`, and `retention <days>` accepts a positive integer of days or `off`
for no expiry; any other value, or omitting the format, SHALL exit 2. Default
retention is 90 days.

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

#### Scenario: A test run enables Stats without touching the developer's database

- GIVEN `KESHA_HOME=/tmp/kesha-test` is set and `KESHA_STATS_DB` is not
- WHEN Maks runs `kesha stats enable` and then a transcription
- THEN the DB is created at `/tmp/kesha-test/stats.sqlite` and the run is recorded there
- AND `~/Library/Application Support/kesha/stats.sqlite` is neither created nor modified

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

> *Technical Note — sources: `src/stats.ts`, `src/cli/stats.ts::statsCommand`;
> `src/stats.ts::resolveStatsDbPath` delegates to `src/state-paths.ts::resolveStatePaths`.
> Stats DB schema v1: tables `settings`, `runs`, `artifacts`, `stage_timings`,
> `errors`. Privacy contract (in every export): `contentFree: true`,
> `neverStored: ["audio bytes","transcripts","input text","output text","file names",
> "full file paths","raw stdout","raw stderr","environment variables","model files"]`.
> Error sanitization: strips stack frames, replaces home/cwd paths with `<path>`,
> redacts URL query strings, redacts JSON text/transcript/stdout/stderr field values,
> truncates to 300 chars. `export` writes to stdout (not stderr). `vacuum` runs
> `pragma wal_checkpoint(TRUNCATE)` then `vacuum`.*

### Requirement: Stats stay off until enabled and record no content

Stats SHALL be disabled by default, with no Stats DB created until
`kesha stats enable` is called. The Stats DB SHALL record only the command name,
timing stages, artifact metadata (format, size in bytes, duration, sample rate,
channels), and sanitized error messages, never transcript text, audio bytes, input
file names, or raw paths.

#### Scenario: An enabled run records its metadata

- GIVEN Maks has run `kesha stats enable`
- WHEN he transcribes `standup.ogg`
- THEN `kesha stats export --format json` shows the run with its command, stage
  timings and the artifact's format, size and duration
- AND neither `standup.ogg` nor its transcript appears in the export

#### Scenario: Stats were never enabled

- GIVEN `kesha stats enable` has never been run
- WHEN Ira transcribes a file
- THEN no Stats DB file is created and nothing is recorded

> *Technical Note — sources: `src/stats.ts::createStatsRecorder` returns a no-op
> recorder while the DB file is absent; `src/stats.ts::enableStats` creates it.*

### Requirement: The Stats DB location follows the state-directories precedence

The Stats DB path SHALL be `KESHA_STATS_DB` when set; otherwise
`<KESHA_HOME>/stats.sqlite` when `KESHA_HOME` is set; otherwise
`~/Library/Application Support/kesha/stats.sqlite` (macOS),
`%APPDATA%\kesha\stats.sqlite` (Windows) or `$XDG_DATA_HOME/kesha/stats.sqlite`
(Linux), the `state-directories` precedence. `KESHA_STATS_DB` SHALL be documented
beside `KESHA_LOG_DIR` and `KESHA_HOME`.

#### Scenario: An explicit Stats DB path wins

- GIVEN `KESHA_STATS_DB=/tmp/kesha-stats.sqlite` and `KESHA_HOME=/tmp/kesha-test` are
  both set
- WHEN Maks runs `kesha stats enable`
- THEN the DB is created at `/tmp/kesha-stats.sqlite`

#### Scenario: Nothing is set on Linux

- GIVEN neither `KESHA_STATS_DB` nor `KESHA_HOME` is set on linux-x64, and
  `XDG_DATA_HOME=/home/ira/.data`
- WHEN Ira runs `kesha stats enable`
- THEN the DB is created at `/home/ira/.data/kesha/stats.sqlite`

> *Technical Note — `KESHA_STATS_DB` existed only in code until the change that added
> the documentation obligation. Source: `src/stats.ts::resolveStatsDbPath`, which
> delegates to `src/state-paths.ts::resolveStatePaths`.*

### Requirement: `kesha support-bundle` creates a redacted diagnostics archive

`kesha support-bundle` SHALL write a `.tar.gz` archive containing:
- `README.txt` — description and privacy notice
- `doctor.json` — redacted JSON doctor report
- `doctor.txt` — redacted human-readable doctor report
- `manifest.json` — archive metadata (entries, generation time, package, format)

When `--include-logs` is passed, three additional entries are added under
`diagnostic-logs/`: `README.txt`, `kesha.ndjson` (a bounded tail of the active log,
default 64 KB), and `status.json`.

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

### Requirement: A Support bundle holds only its listed entries, always redacted

A Support bundle SHALL never contain audio files, transcripts, model files, the Stats
DB, or any file outside its listed entries, and its Redaction SHALL always be on,
equivalent to `kesha doctor --redact`, whatever flags are passed.

#### Scenario: Sona's bundle is redacted without asking

- GIVEN Sona's Model cache lives under her home directory
- WHEN she runs `kesha support-bundle` with no other flag
- THEN the paths in `doctor.json` and `doctor.txt` start with `~/`

#### Scenario: Stats are enabled and logs are requested

- GIVEN Ira has enabled Stats and recorded runs
- WHEN she runs `kesha support-bundle --include-logs`
- THEN the archive holds exactly its seven listed entries and no Stats DB file

> *Technical Note — sources: `src/support-bundle.ts::createSupportBundle` builds the
> fixed entry list and defaults `redact` to true; the CLI command exposes no flag to
> turn it off.*

### Requirement: `kesha support-bundle` reports where it wrote, or why it could not

`--output <path>` SHALL set the archive path; the default SHALL be
`kesha-support-bundle-<ISO-timestamp>.tar.gz` in the current directory. On success
the CLI SHALL report the archive path, entry count, and size in bytes to stderr. On
failure it SHALL exit 1 with the error message.

#### Scenario: Sona takes the default name

- WHEN Sona runs `kesha support-bundle` in `~/Desktop`
- THEN the archive is written there as `kesha-support-bundle-<ISO-timestamp>.tar.gz`
- AND stderr names that path, the entry count and the size in bytes, with nothing on
  stdout

#### Scenario: The output directory does not exist yet

- WHEN Maks runs `kesha support-bundle --output /tmp/kesha-new/diag.tar.gz` and
  `/tmp/kesha-new` does not exist
- THEN the directory is created and the archive is written to that exact path

> *Technical Note — sources: `src/cli/support-bundle.ts::supportBundleCommand` prints
> the three success lines; `src/support-bundle.ts::createSupportBundle` creates the
> parent directory and maps write failures through `bundleWriteFailure`.*

### Requirement: Privacy framing — redaction, allowlists, and size-bucketing are always enforced

Across all diagnostic commands, the CLI SHALL enforce these privacy boundaries as
invariants, not options:

1. A Diagnostic log event with a field outside the allowlist is dropped at write
   time, never truncated.
2. Stats error messages have home and cwd paths replaced with `<path>`, URL query
   strings and content-bearing JSON fields redacted, and are cut to 300 characters
   before storage.
3. Stats artifact records keep audio size in bytes and duration, never file names,
   full paths, or content.

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
> path itself). Audio size bucketing in `src/stats.ts::summarizeSizeBuckets`:
> `<1 MB`, `1-10 MB`, `10-100 MB`, `100 MB+`. Support bundles are bound by
> "A Support bundle holds only its listed entries, always redacted".*

## Open Issues

- `kesha doctor` does not surface the FluidAudio Kokoro external cache size in the
  plain-text format (it is included in the JSON and in the cache components list, but
  the human-readable section omits it); the `--disk` flag on `kesha status` does show
  it correctly.
- `kesha logs` has no `tail` or `cat` action for reading log contents from the CLI;
  the only way to include log contents is via `kesha support-bundle --include-logs`.
- `kesha stats` has no `--json` flag on `status`; machine-readable stats output
  requires `export --format json`.
- The payload carries the CLI version but no separate schema version: consumers
  are expected to tolerate additive growth and to key off the CLI version when
  they need to distinguish shapes. Whether that holds once a second consumer
  beyond the Raycast extension exists is unresolved.
- `kesha doctor --json` and `kesha status --json` overlap in what they report but
  do not share a payload type; keeping them consistent is currently a convention,
  not something a test enforces.
- "On failure it SHALL exit 1" for `kesha support-bundle` disagrees with the code:
  `src/cli/support-bundle.ts` exits through `exitCodeFor`, so a bad `--output` path
  (`E_INVALID_ARG`) exits 2, a full disk (`E_INTERNAL`) exits 4, and an uncoded error
  exits 4. Which of the two is right is unresolved.
