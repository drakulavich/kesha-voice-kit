## ADDED Requirements

### Requirement: Unknown options are rejected before any command runs

The CLI SHALL reject an option that the invoked command does not declare — on the transcription form and on every subcommand — with exactly one stderr line, `error [E_INVALID_ARG]: unknown option <flag>`, naming the closest declared flag when one is within the unknown-command edit-distance threshold, exit 2, and nothing on stdout. The rejection happens before any input is opened or any Engine is spawned, so its cost does not depend on the input. The value following an unknown option is never promoted to an input path.

#### Scenario: Ira misspells a flag that has a near miss

- WHEN Ira runs `kesha --timestamp --json call.ogg`
- THEN stderr is exactly `error [E_INVALID_ARG]: unknown option --timestamp (did you mean --timestamps?)`
- AND stdout is empty
- AND the process exits 2 without opening `call.ogg` or spawning the Engine

#### Scenario: Maks passes an unknown option with a value

- WHEN Maks runs `kesha --languge en call.ogg`
- THEN stderr names `--languge` as an unknown option
- AND `en` is not reported as a missing file
- AND the process exits 2

#### Scenario: A subcommand rejects the same way

- WHEN Ira runs `kesha say --voic en-am_michael "hello"`
- THEN stderr is `error [E_INVALID_ARG]: unknown option --voic (did you mean --voice?)`
- AND the process exits 2 without spawning the Engine

#### Scenario: Declared spellings stay legal

- WHEN Maks runs `kesha --no-vad --lang en call.ogg`
- THEN no unknown-option error is raised, because `--no-vad` and `--lang` are declared and `en` is `--lang`'s value

> *Technical Note — `src/cli/options.ts::findUnknownOption` walks the raw argv
> against the invoked command's citty `args` (long names, their camelCase
> spellings, `--no-<boolean>`, single-letter aliases, `--help`/`--version`), skipping
> the value of a declared string flag and everything after `--`;
> `src/cli/dispatch.ts::runCli` calls `rejectUnknownOptions` after loading the
> command and before `runMain`. The suggestion reuses
> `src/suggest-command.ts::suggestCommand`. Pinned by the "unknown option"
> case in `tests/integration/cli-contracts.test.ts` and
> `tests/unit/cli-options.test.ts`.*

### Requirement: Usage errors the CLI refuses carry the `E_INVALID_ARG` code

Every usage error the CLI answers before doing any work — a contradictory or malformed flag combination, a value out of range, a missing required argument, an unrecognised action name — SHALL print one stderr line of the form `error [E_INVALID_ARG]: <message>` and exit 2, on the transcription form and on every subcommand, so a script can match the stable code rather than the wording.

#### Scenario: Ira's script matches the code on a transcription flag conflict

- WHEN Ira runs `kesha --json --toon call.ogg`
- THEN stderr contains `error [E_INVALID_ARG]: --json and --toon are mutually exclusive`
- AND the process exits 2

#### Scenario: A subcommand's own usage error is coded the same way

- WHEN Maks runs `kesha say --rate 9 "hello"`
- THEN stderr contains `error [E_INVALID_ARG]: --rate must be between 0.5 and 2.0.`
- AND the process exits 2 without spawning the Engine

#### Scenario: An action-style subcommand is coded the same way

- WHEN Ira runs `kesha stats retention soon`
- THEN stderr contains `error [E_INVALID_ARG]: usage: kesha stats retention <days|off>`
- AND the process exits 2

> *Technical Note — `src/cli/options.ts::renderInvalidArg` renders the line;
> the callers are the two validators in `src/cli/main.ts::createMainCommand`,
> `src/cli/say.ts` (flag resolution and the missing-text refusal),
> `src/cli/record.ts` (argument resolution) and
> `src/cli/action-result.ts::emitActionResult` for `logs` and `stats`. Pinned
> by `tests/integration/error-codes-cli.test.ts` and the "validation errors"
> case in `tests/integration/cli-contracts.test.ts`.*

### Requirement: Global flags typed before a subcommand name reach the subcommand

The CLI SHALL treat flag-shaped tokens that precede a subcommand name as that subcommand's flags, so `kesha --debug record --out take.wav` runs `record` with `--debug` applied, and a flag the subcommand does not declare is then reported as an unknown option rather than the subcommand name being read as an input file. When a leading flag carries a separate value, so the subcommand name is not the first non-flag token, the CLI SHALL refuse with `error [E_INVALID_ARG]: put global flags after the subcommand: kesha <name> ...` and exit 2, never reporting the subcommand name as a missing file.

#### Scenario: Maks types the global flag first

- WHEN Maks runs `kesha --debug record --out take.wav --max-seconds 0`
- THEN the `record` subcommand answers, rejecting `--max-seconds 0` with its own coded usage error
- AND stderr never says `record: ... File not found`

#### Scenario: The leading flag is one the subcommand does not have

- WHEN Ira runs `kesha --json record --out take.wav`
- THEN stderr is `error [E_INVALID_ARG]: unknown option --json`
- AND the process exits 2

#### Scenario: A valued leading flag hides the subcommand name

- WHEN Ira runs `kesha --lang en record --out take.wav`
- THEN stderr contains `error [E_INVALID_ARG]: put global flags after the subcommand: kesha record ...`
- AND the process exits 2 without spawning the Engine

> *Technical Note — `src/cli/dispatch.ts::hoistLeadingFlags` moves the leading
> flag-shaped tokens (anything starting with `-` other than `--`) behind the
> first token when that token is a dispatchable subcommand name;
> `src/cli/dispatch.ts::runCli` refuses, before the transcription form parses,
> a token that names a subcommand and is not an existing file. Pinned by the S3-F3 case in
> `tests/integration/cli-contracts.test.ts` and `tests/unit/dispatch.test.ts`.*

## MODIFIED Requirements

### Requirement: `--help` and a bare invocation both print usage to stdout, and differ in Exit code

The CLI SHALL print usage to stdout with an empty stderr when help was asked for, exiting 0. When the CLI was invoked with no input at all — no arguments, or output flags such as `--json` with no files — it SHALL leave stdout empty, print `error [E_INVALID_ARG]: no input file` followed by the same usage block on stderr, and exit 2, so a script that lost its argument fails as a usage error and a consumer that asked for JSON never receives prose on stdout.

#### Scenario: Maks asks what the CLI can do

- WHEN Maks runs `kesha --help`
- THEN stdout names the product, the transcription form, and the flags of the
  top-level transcription command
- AND stderr is empty
- AND the process exits 0

#### Scenario: Ira invokes the CLI with no arguments in a script

- WHEN `kesha` runs with no arguments
- THEN stderr carries `error [E_INVALID_ARG]: no input file` and a usage block starting with the
  `kesha <audio_file> [audio_file ...]` form
- AND stdout is empty
- AND the process exits 2

#### Scenario: The usage block names every dispatchable subcommand

- GIVEN every subcommand `SUBCOMMANDS` dispatches
- WHEN Ira reads the bare-invocation block on stderr to discover the command set
- THEN each dispatchable subcommand — including `init` and `mcp` — is named in
  the listing
- AND adding a subcommand without listing it fails a unit test (#938)

> *Technical Note — the no-argument usage block is a hand-maintained string,
> `USAGE_MESSAGE` in `src/cli/dispatch.ts`, co-located with the `SUBCOMMANDS`
> registry it must mirror; `src/cli/main.ts` writes the coded line and then the
> block to stderr, followed by `process.exit(2)` (S1-1). `tests/unit/dispatch.test.ts` iterates
> `SUBCOMMAND_NAMES` and asserts each appears in `USAGE_MESSAGE`, so the two
> lists can no longer drift apart (#938). `--help` is citty's own renderer over
> the main command's `meta` and `args`, so it shows the transcription flags, not
> each subcommand's. Both stream contracts are asserted in
> `tests/integration/cli-contracts.test.ts`.*

### Requirement: `kesha completions <shell>` prints a bundled completion script

The CLI SHALL print the bundled shell completion script for `bash`, `zsh`, or
`fish` to stdout and exit 0. A missing or unknown shell argument SHALL leave
stdout empty, print `error [E_INVALID_ARG]: <message>` and the usage line to
stderr, and exit 2, so a redirected install gesture never writes a partial
script that a shell would try to source. The script is read from the bundled
`completions/kesha.<shell>` file at runtime.

Each script SHALL keep the shell's own file-path completion for the positional
audio file — `kesha <audio_file>` is the primary invocation — so installing the
completions never completes less than the bare shell did: where the script has
no candidate of its own (a word that is not a subcommand or option), the shell
falls back to filename completion.

#### Scenario: Maks installs zsh completions

- WHEN Maks runs `kesha completions zsh`
- THEN stdout contains the zsh completion script
- AND the process exits 0

#### Scenario: Unknown shell

- WHEN Ira runs `kesha completions powershell`
- THEN stderr contains `error [E_INVALID_ARG]: unknown shell 'powershell' (bash, zsh or fish)` and `usage: kesha completions <bash|zsh|fish>`
- AND stdout is empty
- AND the process exits 2

#### Scenario: Forgotten shell name in the install gesture

- WHEN Maks runs `kesha completions > ~/.zsh/_kesha`
- THEN stderr contains `error [E_INVALID_ARG]: missing shell (bash, zsh or fish)` and the usage line
- AND `~/.zsh/_kesha` is left empty
- AND the process exits 2

#### Scenario: Maks completes an audio path after installing the script

- GIVEN the bundled script for Maks's shell is installed and `meeting.ogg` is in the working directory
- WHEN Maks types `kesha mee` and presses Tab
- THEN the shell completes `meeting.ogg`, as it would with no kesha script installed
- AND `kesha ins` + Tab still completes the `install` subcommand

> *Technical Note — `src/cli/completions.ts::completionsCommand`.
> `src/cli/completions.ts::SHELL_SCRIPTS` maps `bash → kesha.bash`,
> `zsh → kesha.zsh`, `fish → kesha.fish`. Each script is inlined at build time
> with an `import … with { type: "text" }` declaration rather than read through
> `import.meta.url`, because that URL escapes the embedded filesystem in the
> compiled `.deb`/`.rpm` binary (#914). The positional is optional to citty so a
> missing shell reaches the same `run` as an unknown one and exits 2 with the coded
> line, instead of citty's own usage on stdout and exit 1 (S10-1). The
> file-path fallback is `complete -o default` in bash, `_files` beside the
> command list and a `'*:audio file:_files'` spec in zsh, and no global
> `complete -c kesha -f` in fish (S10-2); `src/shell-artifacts.ts` renders all
> three and `tests/unit/shell-artifacts.test.ts` pins the generated text rather
> than spawning a shell.*

### Requirement: Directory arguments are rejected before work starts
When a positional argument is a directory, the CLI SHALL print `<path>: error [E_INVALID_ARG]: is a directory (expected an audio file)` and exit 2 before any progress output or engine spawn, because the rejection is the CLI's own argument check rather than a runtime failure.

#### Scenario: passing a directory
- **WHEN** a user runs `kesha /tmp`
- **THEN** the CLI prints the is-a-directory message, exits 2, and no progress bar or engine invocation occurs

#### Scenario: a directory among real files
- **WHEN** Ira runs `kesha /tmp good.ogg` with the Engine installed
- **THEN** `good.ogg` is still transcribed, the directory is reported with `E_INVALID_ARG`, and the process exits 2
