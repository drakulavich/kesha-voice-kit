## ADDED Requirements

### Requirement: `kesha uninstall` removes the entries Kesha created, wherever they landed

`kesha uninstall` SHALL remove every entry Kesha creates under its name in the four state locations the state-directories precedence resolves, and every FluidAudio subsystem directory Kesha reads or used to read, inside or outside the Model cache. It SHALL remove a directory itself only when nothing is left in it, and keep stdout empty.

#### Scenario: Maks removes a default macOS install

- GIVEN Maks installed Kesha with `--tts --vad --diarize`, set no state variable, and has a recovery recording from an interrupted `kesha record`
- WHEN Maks runs `kesha uninstall` in a terminal and answers yes
- THEN `~/.cache/kesha`, `~/Library/Logs/kesha`, `~/Library/Application Support/kesha` and `<tmpdir>/kesha-mcp` are gone
- AND the Silero VAD and Kokoro G2P directories under the shared FluidAudio roots are gone, and so is every subsystem directory a pre-#688 install left there
- AND stdout is empty and the process exits 0
- AND `kesha status --disk` lists no Kesha component and no Kesha subsystem under an external root

#### Scenario: Ira removes a relocated install with a live Stats journal

- GIVEN `KESHA_HOME=/tmp/kesha-ci`, `KESHA_LOG_DIR=/var/log/kesha`, and `/tmp/kesha-ci/stats.sqlite-wal` holds bytes
- WHEN Ira runs `kesha uninstall --yes`
- THEN `/tmp/kesha-ci/cache`, `/tmp/kesha-ci/stats.sqlite`, its `-wal` and `-shm` files, `/tmp/kesha-ci/mcp-audio` and the `kesha*.ndjson` logs in `/var/log/kesha` are gone
- AND `/tmp/kesha-ci` and `/var/log/kesha` are removed only if nothing else is left in them

#### Scenario: Only empty directories are left

- GIVEN an earlier run removed every entry but `~/.cache/kesha` is still there and empty
- WHEN Ira runs `kesha uninstall --yes`
- THEN `~/.cache/kesha` is gone and the process exits 0

#### Scenario: Nothing is installed

- GIVEN none of the locations exists
- WHEN Ira runs `kesha uninstall --yes`
- THEN stderr says there is nothing to remove, stdout is empty
- AND the process exits 0

> *Technical Note — locations come from `src/state-paths.ts::resolveStatePaths`,
> `src/mcp/audio-output.ts::audioDir` and `src/fluid-roots.ts` (both the legacy and the
> in-cache candidate of each subsystem, not only the one `fluidSubsystemDirs` resolves).
> Kesha's names: logs `kesha.ndjson`, `kesha.<n>.ndjson` and `diagnostic-logs.json`
> (`src/diagnostic-log.ts:11-12`, `:180`), MCP audio `<uuid>.<ext>` (`src/mcp/audio-output.ts:26`). The ownership table
> in design.md is the one list of what is removed.*

### Requirement: Uninstall keeps what Kesha did not create and names it

`kesha uninstall` SHALL NOT remove an entry Kesha did not create: an unknown entry in any of the four state locations, an entry of a shared FluidAudio root that is not a Kesha subsystem directory, an Engine that `KESHA_ENGINE_BIN` points at outside the Model cache, or the CLI package. It SHALL list each kept entry with its size on stderr and print how to remove the CLI package.

#### Scenario: A log variable points at a shared directory

- GIVEN `KESHA_LOG_DIR=$HOME` and `$HOME` holds Maks's own files next to `kesha.ndjson`
- WHEN Maks runs `kesha uninstall --yes`
- THEN only `kesha.ndjson`, any `kesha.<n>.ndjson` and `diagnostic-logs.json` are removed
- AND `$HOME` and everything else in it remain

#### Scenario: Another FluidAudio app shares the root

- GIVEN `~/Library/Application Support/FluidAudio/Models/other-model` was written by another app
- WHEN Maks runs `kesha uninstall --yes`
- THEN Kesha's subsystem directories in that root are gone
- AND `other-model` and the root remain, and stderr names `other-model` as kept

#### Scenario: A planted file survives, a recovery recording does not

- GIVEN the Model cache holds `recordings/live-1.wav` and Ira's `notes.txt`
- WHEN Ira runs `kesha uninstall --yes`
- THEN `recordings/live-1.wav` is gone, `notes.txt` remains and is named on stderr as kept
- AND the Model cache directory stays because it is not empty
- AND every other Kesha entry in the Model cache is gone

#### Scenario: A log directory inside the Model cache

- GIVEN `KESHA_LOG_DIR` points inside `<Model cache>/models`, which also holds Maks's `notes.txt` in that log directory
- WHEN Maks runs `kesha uninstall --yes`
- THEN `notes.txt` and the directories leading to it remain, and every other entry under `models/` is gone

#### Scenario: A custom Engine is left alone

- GIVEN `KESHA_ENGINE_BIN=/opt/kesha/kesha-engine`, outside the Model cache
- WHEN Maks runs `kesha uninstall --yes`
- THEN `/opt/kesha/kesha-engine` remains and stderr names it as kept

### Requirement: Uninstall shows its plan and asks once before removing anything

`kesha uninstall` SHALL print the uninstall plan (each entry with its size and whether it is removed or kept) to stderr before removing anything, and in a terminal SHALL ask once for confirmation. `--yes` SHALL skip the question. When stdin or stdout is not a TTY and `--yes` is not given, it SHALL print the plan, refuse with `E_INVALID_ARG` (exit 2) and a hint naming `kesha uninstall --yes`, and remove nothing.

#### Scenario: Maks confirms

- GIVEN Maks runs `kesha uninstall` in a terminal
- WHEN the plan is shown and Maks answers yes
- THEN the plan listed every removed and kept entry with its size before the question
- AND exactly the entries marked removed are gone, and the process exits 0

#### Scenario: Ira runs it from a script without `--yes`

- GIVEN stdout is a pipe
- WHEN Ira runs `kesha uninstall | cat`
- THEN the plan is printed on stderr and stdout is empty
- AND the process exits 2 with `E_INVALID_ARG` naming `kesha uninstall --yes`
- AND every entry is still on disk

#### Scenario: Maks says no

- GIVEN Maks runs `kesha uninstall` in a terminal
- WHEN Maks answers no, or cancels the question
- THEN nothing is removed
- AND the process exits 0 on no and 130 with `E_INTERRUPTED` on cancel

### Requirement: Uninstall never runs alongside an install of the same Engine path

`kesha uninstall` SHALL take the install lock of the Engine path in effect before it removes anything, without waiting. When an install holds it, uninstall SHALL fail with `E_INSTALL_RACE` naming the lock directory, exit 1, and remove nothing. When the lock cannot be created or read, it SHALL fail the same way instead of continuing unlocked.

#### Scenario: No install is running

- GIVEN no process holds the install lock of the Engine path in effect
- WHEN Ira runs `kesha uninstall --yes`
- THEN uninstall takes the lock, removes the planned entries and releases the lock
- AND the lock stays in place until the last entry is removed, even though it lives inside `engine/`
- AND no lock directory is left behind and the process exits 0

#### Scenario: An install is still downloading

- GIVEN Maks's `kesha install --tts` holds the install lock
- WHEN Maks runs `kesha uninstall --yes` in another terminal
- THEN the process exits 1 with `E_INSTALL_RACE` naming the lock directory
- AND the Model cache is unchanged

#### Scenario: The lock cannot be created

- GIVEN the Engine path's directory is read-only, so no lock directory can be made
- WHEN Ira runs `kesha uninstall --yes`
- THEN the process exits 1 with `E_INSTALL_RACE` naming the path it could not lock
- AND nothing is removed

### Requirement: An entry that cannot be removed is reported, and the rest are still removed

When an entry cannot be removed, `kesha uninstall` SHALL report it with `E_UNINSTALL_PARTIAL`, the path, the reason and what to do (make the path writable or remove it by hand), continue with the remaining entries, and exit 1.

#### Scenario: Every entry is removable

- GIVEN every planned entry and its parent directory are writable
- WHEN Ira runs `kesha uninstall --yes`
- THEN every entry marked removed is gone and stderr carries no `E_UNINSTALL_PARTIAL`
- AND the process exits 0

#### Scenario: An emptied directory cannot be removed

- GIVEN the Diagnostic log directory is writable but its parent is not
- WHEN Ira runs `kesha uninstall --yes`
- THEN the log files are gone, stderr carries `E_UNINSTALL_PARTIAL` naming the log directory, and the process exits 1

#### Scenario: The log directory is read-only

- GIVEN the Diagnostic log directory is not writable
- WHEN Ira runs `kesha uninstall --yes`
- THEN stderr carries `E_UNINSTALL_PARTIAL` naming the log file, why it could not be removed, and the remedy
- AND the Model cache and the Stats DB entries are gone
- AND the process exits 1 and stdout is empty
