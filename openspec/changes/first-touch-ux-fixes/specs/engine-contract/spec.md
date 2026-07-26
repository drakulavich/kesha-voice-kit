## ADDED Requirements

### Requirement: Engine spawn failures surface as E_ENGINE_SPAWN
Any failure to launch the `kesha-engine` binary (missing file, permission denied) SHALL surface to the user as `error [E_ENGINE_SPAWN]` including the attempted binary path, the underlying cause, and a recovery hint (`kesha install`, or `KESHA_ENGINE_BIN` when set). Raw `posix_spawn`/ENOENT exceptions MUST NOT escape to the user.

#### Scenario: engine binary path does not exist
- **WHEN** any CLI or MCP code path spawns the engine and the binary path does not exist
- **THEN** the surfaced error carries code `E_ENGINE_SPAWN`, names the path, and includes an actionable hint
