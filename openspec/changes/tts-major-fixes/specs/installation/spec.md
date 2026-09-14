## MODIFIED Requirements

### Requirement: TTS install is opt-in and requires `--tts`

The CLI SHALL install TTS models only when `--tts` is passed. Bare `--tts` installs
English only. `--tts <lang>…` installs the listed languages. Positional language codes
without `--tts` SHALL fail with `error [E_INVALID_ARG]: …` and exit 2 explaining the
required flag, the usage class every other argument error shares. Unsupported
language codes SHALL fail with `error [E_INVALID_ARG]: …` and exit 2, listing the
supported set, before anything is downloaded and also under `--plan`.

The supported TTS language sets are:

- ONNX build (linux-x64, macOS ONNX): `en`, `es`, `fr`, `it`, `pt`, `ru`
- darwin-arm64 (CoreML): additionally `hi`, `ja`, `zh`

Installs are additive; re-running `kesha install --tts ru` on a system with English
already installed leaves English in place.

#### Scenario: Unsupported language code

- GIVEN the machine is linux-x64 (ONNX build)
- WHEN Ira runs `kesha install --tts zh`
- THEN stderr reads `error [E_INVALID_ARG]: Unsupported TTS language(s): zh. …` listing the supported languages for this platform
- AND the process exits 2

#### Scenario: Language codes without the flag

- WHEN Ira runs `kesha install ru`
- THEN stderr reads `error [E_INVALID_ARG]: Language codes (ru) require the --tts flag, …`
- AND the process exits 2 and nothing is downloaded

#### Scenario: Unsupported language code under --plan

- WHEN Maks runs `kesha install --plan --tts xx`
- THEN the same coded line is printed and the process exits 2 with an empty stdout

### Requirement: `--plan` shows the download plan without changing local state

The CLI SHALL print a human-readable Install plan when `--plan` is passed, listing all
components with their sizes, cache status (cached / needed / refresh), source, and the
expected network bytes for the current run. No files SHALL be downloaded or modified.
On darwin-arm64 the FluidAudio Kokoro ANE chain, the shared G2P bundle and each
requested language's voice pack SHALL appear as sized components, their sizes derived
from the pinned manifest, so `--tts <lang>` for a language whose pack is not staged
states the bytes it will fetch and a staged one counts as cached. The plan also
includes warm-up steps and ends with the equivalent `kesha install …` command.

#### Scenario: Plan for a FluidAudio language that is not staged

- GIVEN darwin-arm64 with English staged and Spanish not
- WHEN Ira runs `kesha install --plan --tts es`
- THEN the plan lists the Spanish voice pack as `needed` with its size
- AND `Expected Kesha-managed network for this run` is that size, not `0 B`

#### Scenario: Plan for a FluidAudio language already staged

- WHEN Ira runs `kesha install --plan --tts en` on the same machine
- THEN the ANE chain and the English pack are marked `cached`
- AND the expected network total is `0 B`
