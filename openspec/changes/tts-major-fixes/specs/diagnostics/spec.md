## MODIFIED Requirements

### Requirement: `kesha status` shows engine and voice install state

`kesha status` SHALL print a concise install summary: Engine binary path and install
status; Backend, protocol version, and features (from the describe document); Bun runtime
version and platform; active Model mirror (when `KESHA_MODEL_MIRROR` is set); and the
list of installed TTS Voice ids. When an Engine is installed and answers, the Voice ids
SHALL be the Engine's own inventory (the same list `kesha say --list-voices` prints,
including FluidAudio Kokoro voices and `macos-*` system voices); only when no Engine is
installed SHALL the list fall back to what the Model cache holds on disk.

#### Scenario: Status agrees with --list-voices

- GIVEN an installed Engine on darwin-arm64
- WHEN Maks compares `kesha status --json | jq '.voices | length'` with `kesha say --list-voices | wc -l`
- THEN the two numbers are equal

#### Scenario: Status without an Engine still lists what is on disk

- GIVEN no Engine binary but Vosk-TTS files in the Model cache
- WHEN Ira runs `kesha status`
- THEN the five `ru-vosk-*` ids are listed from the cache and the setup hint is printed

### Requirement: `kesha doctor` produces a read-only diagnostic report

`kesha doctor` SHALL collect and print a structured diagnostic report covering: CLI
package name and version; Bun runtime version, platform, and architecture; Engine
binary path, install status, version marker, and the describe document (obtained by
probing the Engine); Model cache path, existence, total size, and per-component
breakdown; optional-component install status (VAD, TTS Kokoro, TTS Vosk, FluidAudio
Kokoro cache, Diarization, Sidecars); the TTS languages staged and the installed Voice
ids; Stats DB status; Diagnostic log status; a snapshot of known `KESHA_*` environment
variables; and the four resolved state paths (Model cache, Diagnostic log directory,
Stats DB, MCP audio directory), each with the source that decided it — `default`,
`KESHA_HOME`, or the specific variable — as defined by `state-directories`. The
FluidAudio Kokoro component SHALL report completeness per language: a language whose
voice pack is absent is listed as missing for that language, and the component SHALL
NOT report an empty `missing` list while a supported language cannot be synthesized
from it.

`kesha doctor` SHALL always exit 0, even when components are missing or the Engine
probe fails. It SHALL never download or modify any file.

#### Scenario: Doctor names the languages a Kokoro cache cannot serve

- GIVEN darwin-arm64 with the English ANE chain staged and no Spanish pack
- WHEN Sona runs `kesha doctor --json`
- THEN the FluidAudio Kokoro component lists `en` as staged and `es` among the missing languages
- AND the report carries the installed Voice ids
