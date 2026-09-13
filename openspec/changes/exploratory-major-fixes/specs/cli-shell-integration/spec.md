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
