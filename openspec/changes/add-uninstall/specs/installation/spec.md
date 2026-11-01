## ADDED Requirements

### Requirement: `kesha uninstall` removes what Kesha put on disk, wherever it landed

`kesha uninstall` SHALL remove the Model cache, the Diagnostic log directory, the Stats DB file and the MCP audio directory at the locations the state-directories precedence resolves, and the FluidAudio model directories Kesha reads outside the Model cache, so that after it succeeds `kesha status --disk` reports no Kesha bytes on disk.

#### Scenario: Maks removes a default macOS install

- GIVEN Maks installed Kesha with `--tts --vad --diarize` and set no state variable
- WHEN Maks runs `kesha uninstall` in a terminal and answers yes
- THEN `~/.cache/kesha`, `~/Library/Logs/kesha`, `~/Library/Application Support/kesha/stats.sqlite` and `<tmpdir>/kesha-mcp` are gone
- AND the Parakeet, Silero VAD, Kokoro, Kokoro G2P and Sortformer directories Kesha used under `~/Library/Application Support/FluidAudio`, `~/.cache/fluidaudio` and `~/Library/Application Support/fluidaudio-rs` are gone
- AND `kesha status --disk` afterwards lists no component and no external root with Kesha files
- AND the process exits 0

#### Scenario: Ira removes a relocated install

- GIVEN `KESHA_HOME=/tmp/kesha-ci` and `KESHA_LOG_DIR=/var/log/kesha`
- WHEN Ira runs `kesha uninstall --yes`
- THEN `/tmp/kesha-ci/cache`, `/tmp/kesha-ci/stats.sqlite`, `/tmp/kesha-ci/mcp-audio` and `/var/log/kesha` are gone
- AND `/tmp/kesha-ci` is removed only if nothing else is left in it

#### Scenario: Nothing is installed

- GIVEN none of the locations exists
- WHEN Ira runs `kesha uninstall --yes`
- THEN stderr says there is nothing to remove
- AND the process exits 0

> *Technical Note — the locations come from `src/state-paths.ts::resolveStatePaths`,
> `src/mcp/audio-output.ts::audioDir` and `src/fluid-roots.ts::fluidSubsystemDirs`, the
> same resolution `kesha status --disk` uses (`src/status.ts:212`).*

### Requirement: Uninstall keeps what Kesha did not create and names it

`kesha uninstall` SHALL NOT remove a file or directory Kesha did not create: any top-level entry of the Model cache other than Kesha's own, any entry of a shared FluidAudio root that no Kesha subsystem reads, an Engine that `KESHA_ENGINE_BIN` points at outside the Model cache, and the CLI package. It SHALL list each kept location with its size on stderr, and print how to remove the CLI package.

#### Scenario: Another FluidAudio app shares the root

- GIVEN `~/Library/Application Support/FluidAudio/Models/other-model` was written by another app
- WHEN Maks runs `kesha uninstall --yes`
- THEN Kesha's Parakeet and Silero VAD directories in that root are gone
- AND `other-model` and the root itself remain, and stderr names `other-model` as kept

#### Scenario: A file planted in the Model cache survives

- GIVEN Ira saved `notes.txt` at the top of the Model cache
- WHEN Ira runs `kesha uninstall --yes`
- THEN `notes.txt` remains and is named on stderr as not created by Kesha
- AND every Kesha entry next to it is gone

#### Scenario: A custom Engine is left alone

- GIVEN `KESHA_ENGINE_BIN=/opt/kesha/kesha-engine`, outside the Model cache
- WHEN Maks runs `kesha uninstall --yes`
- THEN `/opt/kesha/kesha-engine` remains and stderr names it as kept

### Requirement: Uninstall shows its plan and asks once before removing anything

`kesha uninstall` SHALL print the uninstall plan (each location with its size and whether it is removed or kept) to stderr before removing anything, and in a terminal SHALL ask once for confirmation. `--yes` SHALL skip the question. When stdin or stdout is not a TTY and `--yes` is not given, it SHALL print the plan, refuse with `E_INVALID_ARG` (exit 2) and a hint naming `kesha uninstall --yes`, and remove nothing.

#### Scenario: Ira runs it from a script without `--yes`

- GIVEN stdin is not a TTY
- WHEN Ira runs `kesha uninstall`
- THEN the plan is printed on stderr, stdout is empty
- AND the process exits 2 with `E_INVALID_ARG` naming `kesha uninstall --yes`
- AND every location is still on disk

#### Scenario: Maks says no

- GIVEN Maks runs `kesha uninstall` in a terminal
- WHEN Maks answers no, or cancels the question
- THEN nothing is removed
- AND the process exits 130 on cancel and 0 on no

### Requirement: Uninstall never runs alongside an install into the same Model cache

`kesha uninstall` SHALL take the install lock of the Model cache it removes, without waiting. When an install holds it, uninstall SHALL fail with an error that names the lock and says an install is running, exit 1, and remove nothing.

#### Scenario: An install is still downloading

- GIVEN Maks's `kesha install --tts` holds the install lock
- WHEN Maks runs `kesha uninstall --yes` in another terminal
- THEN the process exits 1 with an error naming the lock directory
- AND the Model cache is unchanged

### Requirement: A location that cannot be removed is reported, and the rest are still removed

When a location cannot be removed, `kesha uninstall` SHALL report it with an Error code, the path and the reason, continue with the remaining locations, and exit 1.

#### Scenario: The log directory is read-only

- GIVEN the Diagnostic log directory's parent is not writable
- WHEN Ira runs `kesha uninstall --yes`
- THEN stderr names the log directory and why it could not be removed
- AND the Model cache and the Stats DB are gone
- AND the process exits 1

