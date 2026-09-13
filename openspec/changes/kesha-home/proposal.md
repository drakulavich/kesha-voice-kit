## Why

Kesha keeps mutable state in four places resolved by four independent rules: the Model cache (`KESHA_CACHE_DIR`), the Diagnostic log directory (`KESHA_LOG_DIR`), the Stats DB (`KESHA_STATS_DB`, undocumented outside the code) and the MCP audio directory (`<tmpdir>/kesha-mcp`, no override). Isolating a run therefore takes three variables, and anyone who sets only `KESHA_CACHE_DIR` — the one variable every runbook names — still writes into the user's real logs and Stats. The 2026-09-13 exploratory programme did exactly that: four sessions against a private cache appended several hundred runs, including deliberately broken inputs, to `~/Library/Logs/kesha/kesha.ndjson` and `~/Library/Application Support/kesha/stats.sqlite`, and the repo's own test suite has the same gap.

## What Changes

- Add `KESHA_HOME`: one directory that roots every piece of mutable state — `<home>/cache` (Engine, models, recordings, FluidAudio bundles), `<home>/logs`, `<home>/stats.sqlite`, `<home>/mcp-audio` — with the same layout on every platform.
- Precedence is uniform per path: the specific variable (`KESHA_CACHE_DIR`, `KESHA_LOG_DIR`, `KESHA_STATS_DB`) wins, then `KESHA_HOME`, then the platform default. Existing behaviour is unchanged when `KESHA_HOME` is unset; nothing is migrated or moved.
- The CLI resolves all four paths in one place and passes the resolved cache root to the Engine as `KESHA_CACHE_DIR` when `KESHA_HOME` supplied it, so the Engine (which reads only `KESHA_CACHE_DIR`) lands its models and recordings under the same root without learning a new variable.
- `kesha status --json` and `kesha doctor --json` report each state path together with its source (`default`, `KESHA_HOME`, or the specific variable), `doctor` lists `KESHA_HOME` among the known env keys, and support-bundle redaction treats its value as a path.
- Install hints that today say "point `KESHA_CACHE_DIR` at a temp dir" name `KESHA_HOME` first.
- The test harness sets `KESHA_HOME` to a per-run temp directory so the suite stops writing to the developer's real logs and Stats; the leak guard covers that directory.
- Document `KESHA_STATS_DB` (currently code-only) alongside `KESHA_LOG_DIR` and `KESHA_HOME` in one "where Kesha keeps its files" table.

## Capabilities

### New Capabilities
- `state-directories`: the four mutable-state locations, their platform defaults, and the single precedence rule (`specific variable` > `KESHA_HOME` > `default`) that resolves each of them; the contract every other spec refers to instead of restating paths.

### Modified Capabilities
- `engine-contract`: the `KESHA_*` table gains `KESHA_HOME`; the "Engine inherits `process.env`" statement becomes "inherits `process.env`, plus `KESHA_CACHE_DIR` set by the CLI when `KESHA_HOME` resolved the cache root".
- `diagnostics`: the log-directory and Stats-DB path sentences defer to `state-directories`; `status --json` / `doctor --json` expose each path with its source; `KESHA_HOME` joins the known env keys.
- `mcp-server`: the MCP audio directory is the `state-directories` MCP audio path rather than the literal `<tmpdir>/kesha-mcp/`; the sweep requirement and the `synthesize_speech` / `kesha-audio://` wording follow.

## Non-goals

- Teaching the Rust Engine to read `KESHA_HOME`. A direct `kesha-engine` invocation without the CLI keeps `KESHA_CACHE_DIR`.
- A separate override variable for the MCP audio directory. `KESHA_HOME` is the only way to move it until someone needs more.
- Moving or migrating existing files when `KESHA_HOME` is introduced, or on upgrade.
- FluidAudio's own VAD copy under `~/Library/Application Support/FluidAudio`, which FluidAudio places without consulting Kesha (already documented as a legacy root).
- Changing how the CLI's `homedir()` and the Engine's `$HOME` may disagree when neither variable is set.
- `KESHA_ENGINE_BIN`, the Raycast extension and the OpenClaw plugin.
- A config file or XDG profile mechanism.

## Impact

- Code: `src/paths.ts`, `src/diagnostic-log.ts::resolveDiagnosticLogDir`, `src/stats.ts::resolveStatsDbPath`, `src/mcp/audio-output.ts` collapse onto a new `src/state-paths.ts` resolver; `src/engine.ts::spawnEngineProcess` (env injection); `src/doctor.ts::KNOWN_ENV_KEYS`, `src/status.ts` / `src/doctor.ts` JSON shapes (additive fields); install hints in `src/engine-install.ts`.
- Tests: a pure-function precedence matrix for the resolver; a CLI scenario proving that a transcription under `KESHA_HOME` leaves the platform defaults untouched; harness preload and `tests/helpers/leak-guard.ts`.
- Docs: `docs/diagnostic-logs.md`, README env section, a new "Where Kesha keeps its files" table; `docs/errors.md` hint text where `KESHA_CACHE_DIR` is suggested.
- Public API: none — `@drakulavich/kesha-voice-kit/core` exports no path helpers; `transcribe()` picks up `KESHA_HOME` from the environment like the CLI.
- Compatibility: additive. Every existing variable keeps its meaning and its precedence over the new one.
