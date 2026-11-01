## Why

Removing Kesha means reading `docs/architecture.md:275`: `rm -rf ~/.cache/kesha`, plus two FluidAudio directories outside it, plus three more on installs from before #688. Nothing in `kesha --help` leads there. Logs, the Stats DB and MCP audio live elsewhere again, and `KESHA_HOME` or the per-location variables can move each of them.

On the maintainer's Mac the Model cache holds 4.0 GB and the three FluidAudio roots another 1.7 GB, so a user who deletes only `~/.cache/kesha` leaves 1.7 GB behind without knowing it.

Vera ships this as `vera uninstall` (`VeraTools/Vera`, `crates/vera-cli/src/commands/uninstall.rs`): it removes what it created and lists the files it did not create instead of deleting them. #1625.

## What Changes

- New command `kesha uninstall`. It builds an uninstall plan from the locations `kesha status --disk` already resolves, shows it with sizes, asks once in a terminal, and removes what Kesha owns.
- Inside the shared FluidAudio roots it removes only the model directories Kesha reads or left behind, and keeps and names everything else.
- `--yes` skips the question. Without a terminal and without `--yes` it refuses, as `kesha init` does.
- It takes the install lock, so it cannot run while `kesha install` writes into the same Model cache.
- It never removes the CLI package; it prints how to remove it.
- `docs/architecture.md`, the README and the `kesha status --disk` reset hint (`src/status.ts:241`, today `rm -rf <cache>`) point at the command.
- A new Error code, `E_UNINSTALL_PARTIAL`, for an entry that could not be removed. Only the CLI raises it; the Engine publishes it in `describe` with `origin: cli`.

## Non-goals

- Removing the CLI package or any distribution path's files (npm, Homebrew, `.deb`/`.rpm`, container image, Nix). The package manager owns them.
- Removing an Engine that `KESHA_ENGINE_BIN` points at outside the Model cache. The user put it there.
- Deleting whole shared FluidAudio roots, or files in them that no Kesha subsystem reads.
- A `--plan` flag. The question already shows the plan, and a run without a terminal prints it before refusing.
- Uninstalling the Raycast extension or the OpenClaw plugin.

## Capabilities

### Modified Capabilities

- `installation`: adds the uninstall requirements next to install.

## Impact

- New `src/cli/uninstall.ts` and `src/uninstall-plan.ts`; reuses `src/state-paths.ts`, `src/fluid-roots.ts`, `src/diagnostic-paths.ts` and `src/install-lock.ts`.
- `src/cli/main.ts` command table, shell completions and the man page (`bun run generate:shell-artifacts`).
- `docs/architecture.md:275`, README, `docs/errors.md` if a new message needs a row.
- `rust/src/protocol/describe.rs` publishes the new code; the capability pact test lists it as not yet recorded.
- Refs #1625.
