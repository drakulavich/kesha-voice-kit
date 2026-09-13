## MODIFIED Requirements

### Requirement: `KESHA_*` environment variables configure both CLI and Engine

Both the CLI and the Engine SHALL honour the `KESHA_*` environment variables listed below; the CLI SHALL read them at startup and the Engine at spawn time, inheriting `process.env` from the CLI with one addition: when `KESHA_HOME` (and not `KESHA_CACHE_DIR`) resolved the Model cache root, the CLI SHALL set `KESHA_CACHE_DIR` to that resolved root in every Engine spawn's environment, so the Engine lands models and recordings under the same root without reading `KESHA_HOME` itself (`state-directories`). `KESHA_DEBUG_FD` SHALL no longer exist: with `KESHA_DEBUG` set, the Engine's debug timeline SHALL be emitted as `debug` events on the Event stream and the CLI SHALL route them to the Diagnostic log.

> *Technical Note — `KESHA_*` env var table:*
>
> | Variable | Read by | Effect |
> |---|---|---|
> | `KESHA_ENGINE_BIN` | CLI | Override Engine binary path (`src/engine.ts::getEngineBinPath`). |
> | `KESHA_HOME` | CLI | Root every state location under one directory (`cache/`, `logs/`, `stats.sqlite`, `mcp-audio/`); outranked by the specific variables below, outranks the platform defaults. CLI: `src/state-paths.ts::resolveStatePaths`; forwarded to the Engine as `KESHA_CACHE_DIR` by `src/engine.ts::spawnEngineProcess`. |
> | `KESHA_CACHE_DIR` | CLI + Engine | Override Model cache root (default `~/.cache/kesha/`, or `<KESHA_HOME>/cache` when `KESHA_HOME` is set). CLI: `src/paths.ts::keshaCacheDir`. Engine: `rust/src/models/paths.rs::cache_dir`. |
> | `KESHA_MODEL_MIRROR` | Engine | Rewrite HuggingFace download base URLs; GitHub release URLs are never rewritten. Safe because of Pinned hashes (`rust/src/models/download.rs::model_mirror`). |
> | `KESHA_DEBUG` | CLI + Engine | Enable debug trace output. Falsey values: `""`, `"0"`, `"false"`, `"no"`, `"off"` (case-insensitive). Truthy: any other non-empty value. CLI: `src/log.ts::envDebug`. Engine: `rust/src/debug.rs::enabled`; events emitted through `rust/src/protocol/events.rs`. |
> | `KESHA_DIARIZE_TIMEOUT_SECS` | Engine | Cap total diarization wall time (seconds). It can only cut a run short — the phase budgets still apply, so it never widens one. Unset or empty means no overall cap; any other non-positive or unparseable value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` | Engine | Replace the 300 s budget for the CoreML model load (seconds). Does not affect the other phases. Unset or empty keeps the default; any other non-positive or unparseable value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_COMPUTE_UNITS` | Engine | CoreML compute units for the Sortformer model: `all` (default), `cpu-and-ane`, `cpu-and-gpu`, `cpu-only`. An unrecognised value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_MODEL_PATH` | CLI + Engine | Override the Sortformer model path. CLI: `src/engine.ts::assertDiarizeModelInstalled`. Engine: `rust/src/transcribe/mod.rs::resolve_diarize_model_path`. |
> | `KESHA_STATS_DB` | CLI | Override the Stats DB path (`src/stats.ts::resolveStatsDbPath`); outranks `KESHA_HOME`. |
> | `KESHA_LOG_DIR` | CLI | Override the Diagnostic log directory (`src/diagnostic-log.ts::resolveDiagnosticLogDir`); outranks `KESHA_HOME`. |

#### Scenario: Ira points the cache at a network share in CI

- GIVEN `KESHA_CACHE_DIR=/mnt/ci-cache/kesha` is set
- WHEN Ira runs `kesha standup.ogg`
- THEN the CLI resolves the Engine binary from `/mnt/ci-cache/kesha/`
- AND the Engine reads models from `/mnt/ci-cache/kesha/models/`

#### Scenario: Ira isolates a whole run with one variable

- GIVEN `KESHA_HOME=/tmp/kesha-ci` is set and `KESHA_CACHE_DIR` is not
- WHEN Ira runs `kesha standup.ogg`
- THEN the Engine is spawned with `KESHA_CACHE_DIR=/tmp/kesha-ci/cache` in its environment
- AND it reads models from `/tmp/kesha-ci/cache/models/`
- AND every other `KESHA_*` variable reaches the Engine unchanged

#### Scenario: A specific variable outranks the umbrella at the Engine boundary

- GIVEN `KESHA_HOME=/tmp/kesha-ci` and `KESHA_CACHE_DIR=/mnt/models` are both set
- WHEN Maks runs `kesha note.ogg`
- THEN the Engine's environment carries `KESHA_CACHE_DIR=/mnt/models`, untouched by the CLI
- AND the CLI's own Diagnostic log and Stats DB still resolve under `/tmp/kesha-ci`

#### Scenario: Debug timeline with no extra descriptor

- GIVEN `KESHA_DEBUG=1` is set and `KESHA_DEBUG_FD` is also set from an old script
- WHEN Maks runs `kesha note.ogg`
- THEN `KESHA_DEBUG_FD` is ignored
- AND the Engine's `debug` events appear in the Diagnostic log for that run

> *Technical Note — the CLI forwards no descriptor (`tests/unit/protocol-literals.test.ts` pins that `KESHA_DEBUG_FD` is unreferenced in `src/`), `rust/src/debug.rs` opens none, and `rust/tests/debug_structured_events.rs` asserts the `debug` events on stderr with a stale `KESHA_DEBUG_FD` exported to prove it is ignored.*
