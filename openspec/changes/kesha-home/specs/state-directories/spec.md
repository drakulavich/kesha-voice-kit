## ADDED Requirements

### Requirement: Every state location resolves through one precedence rule

The CLI SHALL resolve each of its four mutable-state locations — the Model cache, the Diagnostic log directory, the Stats DB file, and the MCP audio directory — by the same rule: the location's specific variable when set (`KESHA_CACHE_DIR`, `KESHA_LOG_DIR`, `KESHA_STATS_DB`; the MCP audio directory has none), otherwise the path derived from `KESHA_HOME` when set, otherwise the platform default. A variable set to the empty string SHALL count as unset. A relative value SHALL be resolved against the working directory once, when the CLI starts, so every consumer in the process and every Engine spawn sees the same absolute path. The resolution SHALL be a pure function of the environment, platform, home directory and temp directory, with no file-system access, so it is testable as a table.

Platform defaults are unchanged by this requirement: `~/.cache/kesha` for the Model cache on every platform; `~/Library/Logs/kesha`, `%LOCALAPPDATA%\kesha\logs` or `$XDG_STATE_HOME/kesha/logs` for logs; `~/Library/Application Support/kesha/stats.sqlite`, `%APPDATA%\kesha\stats.sqlite` or `$XDG_DATA_HOME/kesha/stats.sqlite` for Stats; `<tmpdir>/kesha-mcp` for MCP audio.

#### Scenario: Ira sets nothing

- GIVEN none of `KESHA_HOME`, `KESHA_CACHE_DIR`, `KESHA_LOG_DIR`, `KESHA_STATS_DB` is set
- WHEN Ira runs any `kesha` command on macOS
- THEN the four locations are the platform defaults above
- AND each reports its source as `default`

#### Scenario: Maks sets only the umbrella

- GIVEN `KESHA_HOME=/Volumes/work/kesha` and no specific variable
- WHEN Maks runs `kesha status --json`
- THEN the Model cache is `/Volumes/work/kesha/cache`, the log directory `/Volumes/work/kesha/logs`, the Stats DB `/Volumes/work/kesha/stats.sqlite`, and the MCP audio directory `/Volumes/work/kesha/mcp-audio`
- AND each reports its source as `KESHA_HOME`

#### Scenario: A specific variable outranks the umbrella for its own location only

- GIVEN `KESHA_HOME=/tmp/kesha-ci` and `KESHA_LOG_DIR=/var/log/kesha`
- WHEN Ira runs `kesha logs path`
- THEN the log directory is `/var/log/kesha` with source `KESHA_LOG_DIR`
- AND the Model cache, Stats DB and MCP audio directory still resolve under `/tmp/kesha-ci`

#### Scenario: An empty variable is not a path

- GIVEN `KESHA_HOME=""` is exported by a script that meant to unset it
- WHEN Maks runs `kesha status`
- THEN every location resolves exactly as if `KESHA_HOME` were absent
- AND the process exits 0 without reporting an empty or unwritable directory

#### Scenario: A relative umbrella is anchored once

- GIVEN `KESHA_HOME=./kesha-state` and the working directory `/work/job`
- WHEN Ira runs `kesha meeting.ogg`
- THEN the Model cache handed to the Engine is `/work/job/kesha-state/cache`
- AND the Diagnostic log for the run is written under `/work/job/kesha-state/logs`

> *Technical Note — `src/state-paths.ts::resolveStatePaths` is the only place the rule
> lives; `src/paths.ts::keshaCacheDir`, `src/diagnostic-log.ts::resolveDiagnosticLogDir`,
> `src/stats.ts::resolveStatsDbPath` and `src/mcp/audio-output.ts::audioDir` are thin
> callers that keep their names for existing importers. The precedence table is pinned by
> a unit test over all three platforms and the eight variable combinations; no test in it
> touches the file system.*

### Requirement: `KESHA_HOME` roots every state location under one directory with one layout

When `KESHA_HOME` is set, the CLI SHALL place its state under it with the same layout on every platform — `cache/`, `logs/`, `stats.sqlite`, `mcp-audio/` — and SHALL create nothing outside it except what a specific variable redirects elsewhere. Setting `KESHA_HOME` SHALL NOT move, copy or delete any existing file: a user who points it at an empty directory starts from an empty Model cache and installs into it explicitly with `kesha install`; the never-auto-download rule applies unchanged. The CLI SHALL forward the resolved Model cache to every Engine spawn as `KESHA_CACHE_DIR` when `KESHA_HOME` decided it, so the Engine's own state (models, `recordings/`, FluidAudio bundles it roots under the cache) lands under the same directory; the Engine itself does not read `KESHA_HOME`.

#### Scenario: Ira isolates a CI job with one line

- GIVEN a fresh runner with `KESHA_HOME=$RUNNER_TEMP/kesha` exported and a private cache already installed there by `kesha install`
- WHEN the job runs `kesha standup.ogg --json` and `kesha stats week`
- THEN the transcript is produced from the Engine and models under `$RUNNER_TEMP/kesha/cache`
- AND the Diagnostic log and Stats rows for the run are under `$RUNNER_TEMP/kesha`
- AND nothing is created under the runner's home directory

#### Scenario: Maks points a second profile at an empty directory

- GIVEN a working install in the default locations and `KESHA_HOME=~/kesha-experiments` naming an empty directory
- WHEN Maks runs `kesha note.ogg`
- THEN the run fails with `E_ENGINE_SPAWN` and the `kesha install` hint, because the new cache is empty
- AND the default install is untouched and works again the moment `KESHA_HOME` is unset

#### Scenario: Sona records under an isolated home

- GIVEN `KESHA_HOME=/tmp/kesha-demo` with the Engine installed there
- WHEN Sona runs `kesha record --live --max-seconds 5`
- THEN the Engine's recovery recording lands under `/tmp/kesha-demo/cache/recordings/`
- AND `~/.cache/kesha/recordings/` is not written

> *Technical Note — forwarding happens in `src/engine.ts::spawnEngineProcess`, which every
> Engine spawn goes through (`runEngine`, `recordEngine`, the install spawn, `say`, and the
> health probes): it sets `KESHA_CACHE_DIR` on the child environment only when the resolved
> cache's source is `KESHA_HOME`, leaving a user-set `KESHA_CACHE_DIR` untouched. The Engine
> reads it in `rust/src/models/paths.rs::cache_dir` as before. The install hints in
> `src/engine-install.ts::assertNotRealCacheUnderTest` and the two "pick a private one"
> messages name `KESHA_HOME` first. The repo's test preload (`tests/helpers/leak-guard.ts`)
> sets `KESHA_HOME` to a per-process temp directory so the suite never writes the
> developer's real logs or Stats.*

## Open Issues

- Normalising an empty variable to "unset" is a deliberate tightening: today
  `KESHA_CACHE_DIR=""` yields an empty cache path that `kesha install` reports as
  unwritable. No user report depends on that behaviour, but it is a change.
- The CLI resolves the default home with Bun's `homedir()` while the Engine uses
  `$HOME`; with neither variable set the two can disagree under a redirected `HOME`.
  This change does not touch that path (forwarding happens only under `KESHA_HOME`).
- FluidAudio's own Silero VAD copy under `~/Library/Application Support/FluidAudio`
  is placed by FluidAudio without consulting Kesha and stays outside `KESHA_HOME`;
  `status --disk` already reports it as an external root.
