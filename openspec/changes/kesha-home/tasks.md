## 1. Resolver (red first)

- [x] 1.1 Write `tests/unit/state-paths.test.ts`: a precedence table over `darwin` / `win32` / `linux` and the eight combinations of `KESHA_HOME`, `KESHA_CACHE_DIR`, `KESHA_LOG_DIR`, `KESHA_STATS_DB` (set / unset), plus the empty-string and relative-path rows; assert path and `source` for all four locations; no file-system access.
- [x] 1.2 Add `src/state-paths.ts::resolveStatePaths(env, platform, homeDir, tmpDir)` returning `{ cacheDir, logDir, statsDbPath, mcpAudioDir }`, each `{ path, source }`, with one `pick()` helper; move the platform branches out of `diagnostic-log.ts` and `stats.ts` unchanged.
- [x] 1.3 Turn `src/paths.ts::keshaCacheDir`, `src/diagnostic-log.ts::resolveDiagnosticLogDir`, `src/stats.ts::resolveStatsDbPath` and `src/mcp/audio-output.ts::audioDir` into one-line callers; run the existing unit suites for those modules.
- [x] 1.4 `just mutate` the precedence: swap the order of the specific-variable and `KESHA_HOME` branches in `pick()` and confirm 1.1 goes red.

## 2. Engine boundary

- [x] 2.1 Unit test on `src/engine.ts::spawnEngineProcess` (through a fake engine that echoes its environment): `KESHA_CACHE_DIR` is injected exactly when the resolved cache's source is `KESHA_HOME`, absent otherwise, and a user-set `KESHA_CACHE_DIR` is never rewritten.
- [x] 2.2 Implement the injection in `spawnEngineProcess` so `runEngine`, `recordEngine`, the install spawn, `say` and the health probes all get it; leave `protocolEnv()` as is.
- [x] 2.3 Delta spec `engine-contract` scenarios pinned in `tests/integration/cli-contracts.test.ts` (or the fake-engine harness): a transcription under `KESHA_HOME` reads models from `<home>/cache/models`.

## 3. Reporting

- [x] 3.1 Add `paths` (four `{ path, source }` entries, keys always present) to `StatusReport` and the `doctor` report; render the source in the human `status` only when it is not `default`; extend `src/doctor.ts::KNOWN_ENV_KEYS` with `KESHA_HOME`; route `paths.*.path` and the `KESHA_HOME` env value through the existing home-prefix redaction.
- [x] 3.2 Tests: `tests/unit/doctor.test.ts` and the status JSON test assert the new keys with every source combination and that `--redact` / `support-bundle` rewrite the home prefix inside `paths` and the `KESHA_HOME` value.
- [x] 3.3 Hints: `assertNotRealCacheUnderTest` fix lines and the two "pick a private one" messages in `src/engine-install.ts` name `KESHA_HOME` first; `docs/errors.md` rows that suggest `KESHA_CACHE_DIR` for isolation gain `KESHA_HOME`.

## 4. Harness isolation

- [x] 4.1 Grep `tests/` for `homedir()`, `Library/Logs`, `stats.sqlite`, `.cache/kesha`, `kesha-mcp`; make each test that asserts a platform default pass an explicit env to the resolver instead of reading the live environment.
- [x] 4.2 `tests/helpers/leak-guard.ts`: set `KESHA_HOME` to a per-process temp directory (registered with the temp-dir reaper) when it is not already set; confirm `isolateEngineCache()` callers still win via `KESHA_CACHE_DIR`.
- [x] 4.3 Integration scenario (`tests/integration/`): with `KESHA_HOME` in a temp dir and Stats enabled there, one transcription through the fake engine leaves the log, the Stats DB and the recordings dir under it and creates nothing under the platform defaults (assert by pre/post listing of those directories).
- [x] 4.4 Run the full suite twice and diff the developer's real `~/Library/Logs/kesha` and `~/Library/Application Support/kesha` sizes before and after: unchanged.

## 5. MCP

- [x] 5.1 `tests/integration/mcp-lifecycle.test.ts`: under `KESHA_HOME`, `synthesize_speech` writes into `<home>/mcp-audio` with mode `0600`, the sweep runs there, and `<tmpdir>/kesha-mcp` is not created.
- [x] 5.2 Update `src/mcp/audio-output.ts` callers if any hard-code the path; keep `0o700` on the directory.

## 6. Docs and spec

- [x] 6.1 Add "Where Kesha keeps its files" to `docs/diagnostic-logs.md` (the table from `design.md` with the precedence line), link it from the README env section and `docs/architecture.md`; this is the first user-facing mention of `KESHA_STATS_DB`.
- [x] 6.2 Add `KESHA_HOME` to the `KESHA_*` table in `docs/` wherever `KESHA_CACHE_DIR` is listed (`docs/use-cases.md`, `docs/architecture.md`).
- [x] 6.3 `bun run check:specs` green; `tests/unit/spec-citations.test.ts` resolves every new `file::symbol` citation once the code exists.
- [ ] 6.4 Update `openspec/specs/GLOSSARY.md` "Model cache" entry to mention the `KESHA_HOME` layout (goes in the sync PR).

## 7. Gate

- [x] 7.1 `just preflight`; scan added lines for Cyrillic; commit in TDD-sized steps.
- [ ] 7.2 PR with the change proposal; adversarial review aimed at the claim "no existing variable changes meaning and no default path changes when `KESHA_HOME` is unset"; Greptile P1/P2 clear; CI on the full head SHA.
- [ ] 7.3 After merge: sync and archive the change (`openspec-sync`, `openspec-archive`) in a follow-up PR, including the GLOSSARY edit.
