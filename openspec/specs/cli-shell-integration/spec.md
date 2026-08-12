# CLI Shell Integration Specification

## Purpose

This spec covers the surface of `kesha` that makes it pleasant to use in shells
and pipelines: global flags that apply to every subcommand (`--quiet`,
`--no-color`), color-disable rules tied to environment variables, the
unknown-command handler that suggests corrections, `kesha completions` for
shell tab-completion, and `kesha manpage` for the bundled man page. Ira relies
on these for scriptable, colorless output in CI. Maks relies on them for a clean
terminal experience on his Mac.

## Non-Goals

- Per-subcommand flag parsing is handled by citty inside each subcommand, not
  by this layer.
- `KESHA_DEBUG` and debug-log output are not covered here; they are detailed in
  the diagnostics spec.
- Color/quiet semantics inside the Engine subprocess are the Engine contract's
  concern; this spec covers propagation from the CLI.
## Requirements
### Requirement: `--quiet` / `-q` suppresses progress output globally

The CLI SHALL strip `--quiet` and `-q` (and `--quiet=<value>`) from `rawArgs`
before passing them to citty, so the flag is effective for every subcommand
without each one declaring it. When quiet is active, `log.progress` and
`log.status` calls produce no output. `log.warn` and `log.error` always print
regardless of quiet.

#### Scenario: Ira runs a transcription in quiet mode

- GIVEN the Engine and models are installed
- WHEN Ira runs `kesha --quiet standup.ogg`
- THEN stdout contains only the transcript text
- AND no spinner or progress lines appear on stderr
- AND the process exits 0

#### Scenario: Quiet applied to a subcommand

- WHEN Ira runs `kesha -q say --voice en-am_michael "hello"`
- THEN no progress lines appear on stderr
- AND the synthesized audio still goes to stdout

#### Scenario: Warnings still appear under quiet

- GIVEN a language mismatch warning would normally be emitted
- WHEN Ira runs `kesha --quiet --lang en ru.ogg`
- THEN the language-mismatch warning still appears on stderr
- AND the process exits 0

> *Technical Note — `resolveQuietMode` in `src/cli/dispatch.ts:103` strips
> `--quiet` / `-q` from `rawArgs` pre-parse and sets `log.quietEnabled`.
> `log.progress` and `log.status` check `log.quietEnabled` before writing;
> `log.warn` and `log.error` do not. Source: `src/log.ts:48-68`.*

### Requirement: `--no-color` disables ANSI color universally

The CLI SHALL resolve color mode from `--no-color`, the `CI` environment
variable, and the `NO_COLOR` environment variable before any subcommand runs.
Two distinct mechanisms cooperate:

1. Per-invocation resolution (`resolveColorMode`): `--no-color` (bare) or
   `--no-color=<truthy>` in `rawArgs` → disable; otherwise `CI` set to a
   non-falsey value → disable (covers GitHub Actions, GitLab, CircleCI, and any
   CI system that sets `CI=true`).
2. Process-start preference: `NO_COLOR` set to a non-falsey value is honored by
   the colorizer library at import time (user-level preference; never cleared
   by the CLI). Because that decision is made at import, a later
   `--no-color=false` cannot override a user-exported `NO_COLOR`.

Falsey values for both flags and env vars are: the empty string, `"0"`,
`"false"`, `"no"`, `"off"` (case-insensitive, trimmed). Any other non-empty
value is truthy.

`--no-color=false` explicitly re-enables color even when `CI=true`.

When the CLI disables color, it sets `NO_COLOR=1` in `process.env` so that
Engine subprocesses spawned later in the same process also see it. When the CLI
re-enables color, it clears `NO_COLOR` from `process.env` — but only when the
CLI itself set it; a user-exported `NO_COLOR` is never cleared.

#### Scenario: Ira pipes output in CI

- GIVEN `CI=true` is set in the environment
- WHEN Ira runs `kesha status`
- THEN all output is plain text with no ANSI escape codes
- AND `process.env.NO_COLOR` is `"1"` when the Engine is spawned

#### Scenario: Developer explicitly re-enables color in CI

- GIVEN `CI=true` in the environment
- WHEN Maks runs `kesha --no-color=false say "hello"`
- THEN ANSI color sequences appear in the output
- AND `NO_COLOR` is cleared from the process environment

#### Scenario: User-exported NO_COLOR is never cleared

- GIVEN `NO_COLOR=1` was exported before the process started
- WHEN a subcommand completes and the CLI processes a second invocation with
  `--no-color=false`
- THEN `process.env.NO_COLOR` is still set (not deleted by the CLI)

#### Scenario: `--no-color=0` re-opts in from a flag value

- WHEN Maks runs `kesha --no-color=0 say "hello"`
- THEN color is enabled (falsey grammar treats `"0"` as false)

> *Technical Note — `resolveColorMode` in `src/cli/dispatch.ts:88` evaluates
> only the `--no-color` flag and `CI`; the `NO_COLOR` env var is honored by
> picocolors at import time (`src/log.ts:1-12`), not inside `resolveColorMode`.
> The `FALSEY_VALUES` set (`src/cli/dispatch.ts:44`) is `{"", "0", "false",
> "no", "off"}`. `USER_FORCED_NO_COLOR` is captured once at module import
> (`src/cli/dispatch.ts:52`) and is used only to decide whether re-enabling may
> clear `NO_COLOR` from `process.env`. The `setColorEnabled` toggle in
> `src/log.ts:15` swaps picocolors between its full and no-op colorizers.
> `--no-color` is stripped from `rawArgs` so citty never sees it.*

### Requirement: Unknown non-path tokens produce a Levenshtein suggestion and exit 1

The CLI SHALL print an "unknown command" error when the first non-flag,
non-path argument does not match any known subcommand, optionally suggest the
closest known command by Levenshtein distance (threshold: distance ≤ 3 AND
≤ 40% of the candidate length), always print a hint that audio files need a
path-like form, and exit 1 without spawning the Engine.

A token is path-like if it contains `.` or `/`, or if it names an existing file
on disk. Path-like first arguments route to transcription instead of triggering
the unknown-command handler.

#### Scenario: Maks typos a subcommand

- WHEN Maks runs `kesha instal`
- THEN stderr contains `unknown command 'instal'`
- AND stderr contains `(Did you mean install?)`
- AND stderr contains `If this is an audio file, pass a path like './instal'.`
- AND the process exits 1

#### Scenario: Completely unrecognised token with no close match

- WHEN Ira runs `kesha xyzzy`
- THEN stderr contains `unknown command 'xyzzy'`
- AND no "Did you mean" line appears (distance exceeds threshold)
- AND the path hint still appears
- AND the process exits 1

#### Scenario: Extensionless file that exists routes to transcription

- GIVEN a file named `meeting` exists in the working directory
- WHEN Maks runs `kesha meeting`
- THEN the CLI routes to the main transcription command (not the unknown-command
  handler)

#### Scenario: Path-like token with extension routes to transcription

- WHEN Ira runs `kesha standup.ogg`
- THEN the CLI routes to the main transcription command (not the unknown-command
  handler), even though `standup.ogg` is not a known subcommand

> *Technical Note — `isPathLike` in `src/cli/dispatch.ts:38`: returns true when
> the token contains `.` or `/` or `existsSync` returns true. `suggestCommand`
> in `src/suggest-command.ts:3` uses `fastest-levenshtein`; threshold is
> `Math.min(3, Math.ceil(match.length * 0.4))` (`src/suggest-command.ts:16`).
> The suggestion is suppressed when `suggestion === firstArg` (exact case-fold
> match already returned by the handler).*

### Requirement: `kesha completions <shell>` prints a bundled completion script

The CLI SHALL print the bundled shell completion script for `bash`, `zsh`, or
`fish` to stdout and exit 0. An unknown shell argument SHALL print a usage
error to stderr and exit 2. The script is read from the bundled
`completions/kesha.<shell>` file at runtime.

#### Scenario: Maks installs zsh completions

- WHEN Maks runs `kesha completions zsh`
- THEN stdout contains the zsh completion script
- AND the process exits 0

#### Scenario: Unknown shell

- WHEN Ira runs `kesha completions powershell`
- THEN stderr contains `usage: kesha completions <bash|zsh|fish>`
- AND the process exits 2

> *Technical Note — `completionsCommand` in `src/cli/completions.ts:20`.
> `SHELL_FILES` maps `bash → kesha.bash`, `zsh → kesha.zsh`,
> `fish → kesha.fish` (`src/cli/completions.ts:4`). The file is loaded via
> `new URL("../../completions/<file>", import.meta.url)`. Unknown shell exits 2
> at `src/cli/completions.ts:35`.*

### Requirement: `kesha manpage` prints the bundled kesha(1) man page

The CLI SHALL print the content of the bundled `man/kesha.1` file to stdout
and exit 0. No arguments are accepted.

#### Scenario: Maks reads the man page

- WHEN Maks runs `kesha manpage`
- THEN stdout contains the kesha(1) man-page in troff/groff format
- AND the process exits 0

> *Technical Note — `manpageCommand` in `src/cli/manpage.ts:3`. File loaded
> via `new URL("../../man/kesha.1", import.meta.url)`. Written directly to
> `process.stdout` — no colorization.*

### Requirement: `--version` prints the CLI version and nothing else

The CLI SHALL print its own version — the version of the installed CLI package, not the Engine's — to stdout as a bare SemVer string, write nothing to stderr, and exit 0.

#### Scenario: Ira pins a version in a CI script

- WHEN Ira runs `kesha --version`
- THEN stdout is a bare SemVer string such as `1.28.0`, optionally with a
  prerelease suffix
- AND stderr is empty
- AND the process exits 0

#### Scenario: The Engine is not installed

- GIVEN no Engine binary is present
- WHEN Ira runs `kesha --version`
- THEN it still prints the CLI version and exits 0, because the CLI version does
  not depend on the Engine

> *Technical Note — citty renders `meta.version`, set from `packageVersion`
> (`src/cli/main.ts:412-416`), which reads `package.json#version` via
> `src/package-info.ts`. The Pinned Engine version is a separate field and is
> surfaced by `kesha status`, not here. Asserted by the "entrypoint help,
> version, and empty invocation keep stable stream contracts" test in
> `tests/integration/cli-contracts.test.ts`.*

### Requirement: `--help` and a bare invocation both print usage to stdout, and differ in Exit code

The CLI SHALL print usage to stdout with an empty stderr in both cases, exiting 0 when help was asked for and 1 when the CLI was invoked with no arguments at all, so a script that lost its argument fails rather than silently succeeding.

#### Scenario: Maks asks what the CLI can do

- WHEN Maks runs `kesha --help`
- THEN stdout names the product, the transcription form, and the flags of the
  top-level transcription command
- AND stderr is empty
- AND the process exits 0

#### Scenario: Ira invokes the CLI with no arguments in a script

- WHEN `kesha` runs with no arguments
- THEN stdout carries a usage block starting with the
  `kesha <audio_file> [audio_file ...]` form
- AND stderr is empty
- AND the process exits 1

#### Scenario: A subcommand exists but the usage block does not name it

- GIVEN a subcommand the hard-coded usage block omits
- WHEN Ira reads that block to discover the command set
- THEN the subcommand is still dispatchable, and still absent from the listing
  — the block is maintained by hand and drifts (see Open Issues)

> *Technical Note — the no-argument usage block is a hand-maintained string at
> `src/cli/main.ts:533-547`, printed with `log.info` (stdout) followed by
> `process.exit(1)`; it lists ten subcommands and omits `init` and `mcp`, both
> of which `SUBCOMMANDS` in `src/cli/dispatch.ts:10-23` dispatches. `--help` is
> citty's own renderer over the main command's `meta` and `args`, so it shows
> the transcription flags, not each subcommand's. Both stream contracts are
> asserted in `tests/integration/cli-contracts.test.ts`.*

### Requirement: Result-producing commands follow the stdout-purity principle

The CLI SHALL write only the primary result to stdout for commands whose
stdout is the deliverable (transcription, `say` without `--out`, JSON/TOON
output, completion scripts, the man page); spinner, status, warning, error,
and debug output SHALL go to stderr so the result can be piped without
filtering.

#### Scenario: Ira pipes a JSON transcript to jq

- WHEN Ira runs `kesha --json call.ogg | jq '.[] | .text'`
- THEN `jq` receives clean JSON on stdin with no interleaved progress text
- AND stderr carries any spinner or warning lines

> *Technical Note — `log.info`, `log.success`, and `log.progress` use
> `console.log` (stdout); `log.warn`, `log.error`, and `log.status` use
> `process.stderr.write` to avoid Bun's startup-frozen TTY auto-red that
> `console.error` would apply. `log.progress` (stdout) is used only in install
> flows (`src/progress.ts:146`, `src/engine-install.ts`), which produce no
> machine-readable stdout result. Source: `src/log.ts:46-68`.*

### Requirement: Directory arguments are rejected before work starts
When a positional argument is a directory, the CLI SHALL print `<path>: is a directory (expected an audio file)` and exit 1 before any progress output or engine spawn.

#### Scenario: passing a directory
- **WHEN** a user runs `kesha /tmp`
- **THEN** the CLI prints the is-a-directory message, exits 1, and no progress bar or engine invocation occurs

### Requirement: Unknown commands suggest near misses
When the first positional token is not a file and not a known subcommand, the CLI SHALL suggest the closest subcommand name when one is within edit distance, and for near-misses of "transcribe" SHALL additionally state that transcription is invoked by passing the audio path directly.

#### Scenario: typo of a subcommand
- **WHEN** a user runs `kesha statsu`
- **THEN** the output suggests `stats`

#### Scenario: typo of transcribe
- **WHEN** a user runs `kesha transcrib`
- **THEN** the output explains transcription is invoked as `kesha <audio-file>` in addition to the existing file hint

## Open Issues

- `--no-color` is not forwarded to the Engine subprocess explicitly; it relies
  on `process.env.NO_COLOR` propagation. If the Engine is spawned via a shell
  wrapper that resets the environment, the Engine may still produce ANSI codes.
- Install-flow progress lines (`log.progress`) print to stdout, not stderr.
  Harmless today because install has no machine-readable stdout, but it breaks
  the corpus-wide "progress goes to stderr" intuition — candidate for moving to
  `log.status` (stderr).
- There is no `--color` flag to force color on when stdout is not a TTY (e.g.
  inside tmux with `TERM=dumb`); `FORCE_COLOR` from picocolors is the current
  workaround.
- The bare-invocation usage block omits `init` and `mcp` — two dispatchable
  subcommands, one of them the command interactive missing-model errors
  recommend ([installation](../installation/spec.md), "Documented install entry
  points match interactive hints"). Nothing keeps the hand-written list and
  `SUBCOMMANDS` in sync, so it will drift again.
- `kesha completions` and `kesha manpage` both resolve their file relative to
  `import.meta.url`, which does not survive the `bun build --compile` step the
  `.deb`/`.rpm` are built with, so on that install path both crash with an
  unhandled `ENOENT` instead of printing or failing cleanly. Reproduction and
  scope: [cli-distribution](../cli-distribution/spec.md), Open Issues.
