## MODIFIED Requirements

### Requirement: `kesha init` is the interactive guided setup
`kesha init` SHALL present an interactive guided setup for new users: a description
of optional features, a multi-select TTS language picker (English pre-checked), a
yes/no prompt for VAD, and a yes/no prompt for diarization (darwin-arm64 only). After
selection, it shows the Install plan and asks for confirmation before running the
install.

`--yes` accepts all current defaults non-interactively and runs the install
immediately. `--plan` prints the overview and plan without prompting or downloading.

When stdin or stdout is not a TTY, `kesha init` prints the overview, plan, and a set
of suggested `kesha install` commands instead of prompting — it never hangs waiting
for interactive input.

`--diarize` on a non-darwin-arm64 platform is silently dropped with a warning; the
install proceeds without it.

Cancelling any prompt (Ctrl-C or Escape) SHALL end `kesha init` with `Init cancelled.`
and exit 130 — the same code an interrupted `kesha install` reports — so a chained
`kesha init && …` does not continue as though setup had succeeded. Nothing is
downloaded on that path.

#### Scenario: Maks runs guided setup on Apple Silicon

- GIVEN the machine is darwin-arm64 with a TTY
- WHEN Maks runs `kesha init`
- THEN the CLI displays available optional features, prompts for TTS language
  selection (English pre-checked), prompts for VAD and diarization
- AND shows the Install plan for the selected components
- AND asks for confirmation before starting the download

#### Scenario: Ira runs init in a CI pipeline (no TTY)

- GIVEN stdin is not a TTY
- WHEN Ira runs `kesha init`
- THEN the CLI prints the overview, a representative install plan, and a list of
  suggested `kesha install` commands
- AND exits 0 without blocking on a prompt

#### Scenario: `--yes` for scripted install with defaults

- WHEN Ira runs `kesha init --yes --tts`
- THEN the CLI runs `kesha install --tts` immediately with no interactive prompts
- AND exits 0 on success

#### Scenario: `--diarize` dropped on non-darwin-arm64

- GIVEN the machine is linux-x64
- WHEN Ira runs `kesha init --yes --diarize`
- THEN a warning is printed: `--diarize is currently darwin-arm64 only; omitting it`
- AND the install proceeds without the diarize model

#### Scenario: Maks presses Ctrl-C at a prompt

- GIVEN Maks runs `kesha init && kesha meeting.ogg` in a TTY
- WHEN Maks presses Ctrl-C at the TTS language picker
- THEN the CLI prints `Init cancelled.` and exits 130
- AND nothing is downloaded
- AND `kesha meeting.ogg` does not run

> *Technical Note — sources: `src/cli/init.ts::initCommand`,
> `src/cli/init.ts::promptInitSelection`, `src/cli/init.ts::runNonInteractive`,
> `src/cli/init.ts::canInstallDiarizeOnPlatform`. The TTS language picker uses
> `@clack/prompts::multiselect` with `required: false` (no-selection = skip TTS).
> TTY check: `process.stdin.isTTY === true && process.stdout.isTTY === true`.
> A cancelled clack prompt returns `isCancel`'s sentinel rather than throwing;
> `src/cli/init.ts::exitIfCancelled` turns it into `process.exit(130)`. Pinned by
> `tests/unit/init.test.ts` (S4-F1).*
