## MODIFIED Requirements

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
human-readable prose.

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
  `kesha install` when stderr is piped (`installHint()`, `src/status.ts:88`)
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
  the protocol version, the features, and the installed TTS Voice ids
- AND the process exits 0

#### Scenario: Engine missing under `--json`

- GIVEN no Engine is installed
- WHEN Ira runs `kesha status --json`
- THEN the object reports Engine presence as `false` and carries the same
  actionable setup hint the human path writes to stderr
- AND stderr does not repeat that hint
- AND the process exits 0

#### Scenario: Capabilities probe fails under `--json`

- GIVEN the Engine binary exists but `--capabilities-json` cannot be read
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
> returns null when unset or empty. Capabilities come from
> `src/engine.ts::getEngineCapabilities` (`src/engine.ts:348`), which returns null on a
> failed or unparseable probe — that null is what the payload reports. The `--json`
> flag follows the `doctor` precedent at `src/cli/doctor.ts:16-32`.*

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
