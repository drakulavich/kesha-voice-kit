## Context

Four modules each derive one state location from the environment and the platform, with no shared code:

| State | Resolver today | Override | Default (macOS / Windows / Linux) |
|---|---|---|---|
| Model cache (Engine, models, `recordings/`, FluidAudio bundles) | `src/paths.ts::keshaCacheDir` | `KESHA_CACHE_DIR` | `~/.cache/kesha` everywhere |
| Diagnostic log directory and its state file | `src/diagnostic-log.ts::resolveDiagnosticLogDir` | `KESHA_LOG_DIR` | `~/Library/Logs/kesha` / `%LOCALAPPDATA%\kesha\logs` / `$XDG_STATE_HOME/kesha/logs` |
| Stats DB | `src/stats.ts::resolveStatsDbPath` | `KESHA_STATS_DB` | `~/Library/Application Support/kesha/stats.sqlite` / `%APPDATA%\kesha\stats.sqlite` / `$XDG_DATA_HOME/kesha/stats.sqlite` |
| MCP audio directory | `src/mcp/audio-output.ts::audioDir` | none | `<tmpdir>/kesha-mcp` |

The Engine reads `KESHA_CACHE_DIR` itself (`rust/src/models/paths.rs::cache_dir`) and inherits `process.env` from the CLI, which `src/engine.ts::spawnEngineProcess` passes explicitly because Bun snapshots the environment at startup (#874). The test harness isolates only the cache (`tests/helpers/fake-engine.ts::isolateEngineCache`, guarded by `src/engine-install.ts::assertNotRealCacheUnderTest`), so every test and every ad-hoc run against a private cache still writes the developer's real log and Stats DB. Stakeholders: Ira (isolation in CI and scripts), Maks (a second profile beside a real install), the test suite.

## Goals / Non-Goals

**Goals:**
- One variable, `KESHA_HOME`, isolates everything Kesha writes, with one layout on every platform.
- No behaviour change when it is unset; every existing variable keeps its meaning and outranks it.
- One resolver, unit-testable without a file system, and a user-visible way to check what resolved (`status --json`, `doctor --json`).
- The repo's own suite stops touching the developer's real state.

**Non-Goals:** the list in `proposal.md` — no Engine-side `KESHA_HOME`, no MCP-specific override, no migration, no FluidAudio legacy roots, no config file, no fix for the `homedir()` vs `$HOME` disagreement between CLI and Engine when neither variable is set.

## Decisions

### D1. A new umbrella variable, not a wider `KESHA_CACHE_DIR`

`KESHA_CACHE_DIR` is the variable every runbook, CI job and test already sets for models only. Making it also move logs and Stats would silently relocate those for everyone who set it for disk-space reasons (`docs/use-cases.md` recommends exactly that). A new name is additive; precedence `specific > KESHA_HOME > default` makes the two coexist without a rule anyone has to remember. Alternatives: extend `KESHA_CACHE_DIR` (breaking for the common case); a config file (a second source of truth beside the environment; nothing else in Kesha reads one).

### D2. One resolver module, four thin callers

`src/state-paths.ts` exports a pure `resolveStatePaths(env, platform, homeDir, tmpDir)` returning `{ cacheDir, logDir, statsDbPath, mcpAudioDir }` plus, for each, `source: "default" | "KESHA_HOME" | "<specific variable>"`. The four existing functions keep their names and signatures and become one-line calls with `process.env`, `process.platform`, `homedir()` and `tmpdir()`, so no caller changes. The precedence rule lives in one `pick()` helper applied four times; the platform branches move here from `diagnostic-log.ts` and `stats.ts` unchanged. An empty-string variable counts as unset (today `KESHA_CACHE_DIR=""` yields `""`, which the install path then reports as unwritable — the resolver normalises this for all four; recorded as a deliberate tightening). A relative `KESHA_HOME` is resolved against the working directory once, at the resolver call, so the CLI and the Engine agree even if either changes directory.

Layout under `KESHA_HOME`: `cache/`, `logs/`, `stats.sqlite`, `mcp-audio/`. The same on every platform — the point of the variable is not having to know the platform; the platform-specific defaults apply only when it is unset.

### D3. The Engine learns nothing; the CLI forwards the resolved cache root

The Engine already accepts `KESHA_CACHE_DIR`. `spawnEngineProcess` (and the install-time spawns that go through it) adds `KESHA_CACHE_DIR=<resolved cacheDir>` to the child environment **only when** `cacheDir.source === "KESHA_HOME"`. Two alternatives were rejected: teaching `rust/src/models/paths.rs::cache_dir` a `KESHA_HOME` fallback (a second copy of the precedence rule, and a protocol-adjacent change to the Engine for a CLI concern); injecting the resolved value unconditionally (that would also override the Engine's own `$HOME`-based default with the CLI's `homedir()`-based one, which is the separate disagreement listed as a non-goal, and it would change every existing spawn's environment). `describe` and `validateArgv` are untouched: no new flag, no new gate row.

### D4. Report the resolution, do not just apply it

`StatusReport` gains `paths: { cache, logs, stats, mcpAudio }`, each `{ path, source }`; `doctor --json` gains the same object; the human `status` prints the source only when it is not `default`. Keys are always present (the `StatusReport` contract), so consumers see `source: "default"` rather than an absent key. `KESHA_HOME` joins `src/doctor.ts::KNOWN_ENV_KEYS` and its value is redacted through the existing home-path redaction, because it is a path. This is what lets Ira verify isolation in one command instead of inferring it from file timestamps — the gap that let the exploratory sessions pollute a real Stats DB unnoticed.

### D5. The harness isolates everything, with the resolver as the guard's oracle

`tests/helpers/leak-guard.ts` (preloaded into every test process) sets `KESHA_HOME` to a per-process temp directory when the variable is not already set, registers it with the existing temp-dir reaper, and `assertNotRealCacheUnderTest` names `KESHA_HOME` first in its fix hint. Existing `isolateEngineCache()` callers keep working: their `KESHA_CACHE_DIR` outranks the harness's `KESHA_HOME`. Unit tests of the resolver pass an explicit `env` object, so they are unaffected by the preload; the few existing tests that assert a platform default path must pass an env without `KESHA_HOME` rather than rely on the process environment (found by running the suite; listed in tasks).

### D6. Hints and documentation name the umbrella first

`assertNotRealCacheUnderTest`'s fix lines and the two "pick a private one" install hints in `src/engine-install.ts` list `KESHA_HOME` before `KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN`. One table, "Where Kesha keeps its files", goes into `docs/diagnostic-logs.md` (the page that already documents `KESHA_LOG_DIR`) and is linked from the README env section and `docs/architecture.md`; it is the first place `KESHA_STATS_DB` appears in user documentation.

## Risks / Trade-offs

- [The harness now sets `KESHA_HOME` for every test process, and a test that asserts a platform default path reads it from the live environment] → the resolver takes `env` as an argument; those tests pass an explicit env; a grep for `homedir()` / `Library/Logs` / `stats.sqlite` in `tests/` finds them before the change lands.
- [Injecting `KESHA_CACHE_DIR` into the Engine env diverges from "inherits `process.env`"] → the engine-contract spec states the one exception; `tests/unit/protocol-literals.test.ts`-style pins are not needed because no protocol literal changes, but a unit test asserts the injected key is present exactly when `source === "KESHA_HOME"`.
- [A user sets `KESHA_HOME` expecting existing files to move] → `status` shows the new empty locations with `source: KESHA_HOME`, and the docs say nothing is migrated; `kesha install` into the new cache is the documented step.
- [MCP audio under `KESHA_HOME/mcp-audio` outlives a reboot, unlike `<tmpdir>`] → the 24-hour sweep already bounds it; permissions stay `0700`/`0600`.
- [Empty-string normalisation changes today's `KESHA_CACHE_DIR=""` failure into a silent default] → deliberate; called out in the spec's Open Issues so a reviewer can object.
- [Windows paths with a drive-relative `KESHA_HOME`] → `path.resolve` handles it; the resolver test matrix includes a `win32` row.

## Migration Plan

Additive, one PR (spec change proposal, resolver, callers, harness, docs), followed by the usual sync-and-archive PR. Rollback is reverting the PR: no on-disk state is created unless a user opts in by setting the variable. No release-note action beyond documenting the variable.

## Open Questions

- Whether `kesha init` should mention `KESHA_HOME` in its summary (leaning no: init is the zero-config path).
- Whether the Raycast extension and the OpenClaw plugin should surface `KESHA_HOME` in their settings (out of scope here; a follow-up if either needs isolation).
