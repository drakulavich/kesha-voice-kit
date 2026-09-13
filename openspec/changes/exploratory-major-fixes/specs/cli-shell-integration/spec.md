## MODIFIED Requirements

### Requirement: `kesha completions <shell>` prints a bundled completion script

The CLI SHALL print the bundled shell completion script for `bash`, `zsh`, or
`fish` to stdout and exit 0. An unknown shell argument SHALL print a usage
error to stderr and exit 2. The script is read from the bundled
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
- THEN stderr contains `usage: kesha completions <bash|zsh|fish>`
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
> compiled `.deb`/`.rpm` binary (#914). An unknown shell exits 2 from the same
> command's `run`. The fallback is `complete -o default` in bash, `_files`
> beside the command list and a `'*:audio file:_files'` spec in zsh, and no
> global `complete -c kesha -f` in fish (S10-2); `src/shell-artifacts.ts`
> renders all three and `tests/unit/shell-artifacts.test.ts` pins the generated
> text rather than spawning a shell.*
