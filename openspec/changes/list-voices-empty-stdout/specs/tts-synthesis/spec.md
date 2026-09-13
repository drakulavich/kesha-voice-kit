## MODIFIED Requirements

### Requirement: List installed voices

`kesha say --list-voices` SHALL print one installed Voice id per line, sorted,
to stdout and exit 0. The list covers Kokoro voices (the FluidAudio catalog on
darwin-arm64; cached `.bin` packs elsewhere), the five Vosk Russian speakers
when the Vosk model is installed, and the OS-provided `macos-*` voices on
macOS. With nothing installed stdout SHALL be empty, the `kesha install --tts`
hint SHALL be emitted as a `progress` event on stderr, and the process SHALL
still exit 0: stdout is the list, and a sentence there is a Voice id to every
consumer of the list — the MCP `list_voices` tool reported it as one voice with
an unknown model and no language (#1168).

#### Scenario: Maks lists voices on Apple Silicon

- WHEN Maks runs `kesha say --list-voices`
- THEN stdout lists `en-am_michael`, `es-em_alex`, `zh-zm_050`,
  `ru-vosk-m02`, and his installed `macos-*` voices, sorted
- AND the process exits 0

#### Scenario: Nothing installed yet

- GIVEN a fresh machine with no TTS models
- WHEN Ira runs `kesha say --list-voices`
- THEN stdout is empty
- AND stderr carries a `progress` event reading `No voices installed. Run: kesha install --tts`
- AND the process exits 0

> *Technical Note — enumeration: the `list_voices` branch of
> `rust/src/cli/say.rs::run`; the CLI relays the Engine's stdout and exit code
> verbatim (`src/synth.ts::listVoiceIds`, shared by the `kesha say` flag and
> the MCP `list_voices` tool). Partial Vosk installs advertise no `ru-vosk-*`
> voices (same cache gate as synthesis). AVSpeech enumeration is best-effort:
> a missing Sidecar still shows Kokoro/Vosk voices.*
