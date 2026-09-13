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
