## MODIFIED Requirements

### Requirement: `kesha doctor` produces a read-only diagnostic report

`kesha doctor` SHALL collect and print a structured diagnostic report covering: CLI
package name and version; Bun runtime version, platform, and architecture; Engine
binary path, install status, version marker, and the describe document (obtained by
probing the Engine); Model cache path, existence, total size, and per-component
breakdown; optional-component install status (VAD, TTS Kokoro, TTS Vosk, FluidAudio
Kokoro cache, Diarization, Sidecars); Stats DB status; Diagnostic log status; and a
snapshot of known `KESHA_*` environment variables.

`kesha doctor` SHALL always exit 0, even when components are missing or the Engine
probe fails. It SHALL never download or modify any file.

Install status for the Engine binary and the Sidecars SHALL be established by running
them, not by testing that the file exists. A binary that is present but which the OS
refuses to execute SHALL be reported as corrupt with a reinstall hint, distinctly from
one that is not installed.

`--json` outputs the same data as 2-space-indented JSON to stdout.

`--redact` replaces secret-pattern key values (keys containing TOKEN, KEY, SECRET,
PASSWORD, CREDENTIAL, or AUTH) with `[REDACTED]`, rewrites home-directory path
prefixes to `~`, and strips URL credentials and query strings. Redaction is opt-in
for `kesha doctor`; it is always-on for `kesha support-bundle`.

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
  `optionalComponents`, `stats`, `diagnosticLogs`, and `env` keys
- AND the process exits 0

#### Scenario: Maks checks an install an interrupted download left behind

- GIVEN the `say-avspeech` sidecar file exists but is truncated
- WHEN Maks runs `kesha doctor`
- THEN the report shows it as installed but not executable, with a `kesha install` hint
- AND a sidecar that is simply absent is still shown as missing
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

> *Technical Note — sources: `src/doctor.ts::collectDoctorReport`,
> `src/doctor.ts::formatDoctorReport`, `src/cli/doctor.ts::doctorCommand`.
> Executability comes from `src/engine-health.ts::probeExecutable` and surfaces as
> `engine.runnable` and per-component `runnable` in the JSON report; any exit code counts
> as healthy, since the sidecars legitimately exit non-zero when given no work.
> Known env keys snapshot: `KESHA_ENGINE_BIN`, `KESHA_CACHE_DIR`,
> `KESHA_MODEL_MIRROR`, `KESHA_STATS_DB`, `KESHA_DEBUG` (from `KNOWN_ENV_KEYS`);
> `KESHA_DEBUG_FD` is dropped from that list at `src/doctor.ts:37`. Secret-pattern
> detection splits the key on non-alphanumeric characters and checks each part against
> `["TOKEN","KEY","SECRET","PASSWORD","CREDENTIAL","AUTH"]`. URL redaction strips
> `username`, `password`, `search`, and `hash`. Home-path redaction rewrites the
> exact home prefix to `~`; case-insensitive on Windows.*

### Requirement: `kesha status` shows engine and voice install state

`kesha status` SHALL print a concise install summary: Engine binary path and install
status; Backend, protocol version, and features (from the describe document); Bun runtime
version and platform; active Model mirror (when `KESHA_MODEL_MIRROR` is set); and the
list of installed TTS Voice ids.

`--disk` SHALL additionally print a per-component disk-usage table (Engine, ASR,
Language ID, VAD, TTS Kokoro, TTS Vosk) and the grand total. The FluidAudio Kokoro
external cache is reported separately when it exists, because it lives outside
Kesha's Model cache.

When the Engine is not installed, `kesha status` prints an actionable setup hint
(`kesha init` on an interactive TTY, `kesha install` when stderr is piped) and
exits 0.

`--json` SHALL replace the human-readable rendering with a single JSON object on
stdout and SHALL print nothing else to stdout. The object SHALL report, at minimum:
Engine presence as a boolean, the resolved Engine binary path, Backend, protocol
version, and features, the installed TTS Voice ids, the Bun runtime version, the
platform and architecture, the active Model mirror, and — when the Engine is
absent — the same setup hint the human path writes to stderr.

The presence boolean SHALL report only that the Engine binary exists, not that it
is usable. Backend, protocol version, and features SHALL be grouped under a single
nested capabilities value so that a binary which cannot report them yields one
null rather than three, making "can the Engine run" a single check; consumers
deciding that SHALL require presence AND non-null capabilities. Consumers SHALL be
able to reach both conclusions from these fields without matching any
human-readable prose. The nested value's shape and key name SHALL NOT change with
protocol version 4, so the Raycast extension keeps reading it unmodified.

Every documented key SHALL be present in every payload: absent values are null
(or the empty list for Voice ids), never omitted, so a consumer never has to tell
a missing key apart from a null value. The payload SHALL also carry the CLI
version, so a consumer that needs to distinguish payload shapes has the version
to key off without a second invocation.

Under `--json` the setup hint SHALL NOT also be written to stderr, because it is
carried in the payload; `--json --disk` SHALL include the per-component disk
breakdown as structured data, and plain `--json` SHALL omit it, mirroring the
human flag's scope. When the Engine is absent, `--json --disk` SHALL report the
disk breakdown as null rather than walking the Model cache, matching the human
path, which computes disk usage only when the Engine is installed. Both modes SHALL derive their content from one collector, so
the two renderings can never disagree. `--json` SHALL exit 0 whether or not the
Engine is installed, matching the human path.

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
  `kesha install` when stderr is piped (`installHint()`, `src/status.ts:110`)
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

> *Technical Note — sources: `src/status.ts::showStatus`, `src/status.ts::showDiskUsage`,
> `src/cli/status.ts::statusCommand`. TTS voice enumeration reads `kokoro-82m/voices/*.bin`
> (prefixed `en-`) and checks `vosk-ru/model.onnx` + `vosk-ru/bert/model.onnx` presence
> (voices `ru-vosk-f01`, `ru-vosk-f02`, `ru-vosk-f03`, `ru-vosk-m01`, `ru-vosk-m02`).
> `activeModelMirror()` trims and strips trailing slashes from `KESHA_MODEL_MIRROR`;
> returns null when unset or empty. Capabilities come from `getEngineCapabilities`
> (`src/engine.ts:633`) today and from the cached describe document in
> `src/engine/describe.ts` after this change; either returns null on a failed or
> unparseable probe — that null is what the payload reports. The `--json`
> flag follows the `doctor` precedent at `src/cli/doctor.ts:16-32`. The Raycast
> extension reads the nested value at `raycast/src/lib/kesha-bin.ts:240-253`.*
