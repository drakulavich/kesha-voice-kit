## MODIFIED Requirements

### Requirement: `KESHA_*` environment variables configure both CLI and Engine

Both the CLI and the Engine SHALL honour the `KESHA_*` environment variables
listed below. The CLI SHALL read them at startup; the Engine SHALL read them at
spawn time (inheriting `process.env` from the CLI).

> *Technical Note — Full `KESHA_*` env var table:*
>
> | Variable | Read by | Effect |
> |---|---|---|
> | `KESHA_ENGINE_BIN` | CLI | Override Engine binary path (`src/engine.ts:47`). |
> | `KESHA_CACHE_DIR` | CLI + Engine | Override Model cache root (default `~/.cache/kesha/`). CLI: `src/paths.ts:5`. Engine: `rust/src/models.rs:614`. |
> | `KESHA_MODEL_MIRROR` | Engine | Rewrite HuggingFace download base URLs; GitHub release URLs are never rewritten. Safe because of Pinned hashes (`rust/src/models.rs:628`). |
> | `KESHA_DEBUG` | CLI + Engine | Enable debug trace output. Falsey values: `""`, `"0"`, `"false"`, `"no"`, `"off"` (case-insensitive). Truthy: any other non-empty value. CLI: `src/log.ts:30`. Engine: `rust/src/debug.rs:57`. |
> | `KESHA_DEBUG_FD` | CLI + Engine | Forward a file descriptor number to the Engine for NDJSON debug event output. Values 0/1/2 are rejected (covered by stdin/stdout/stderr). Values above 1024 (`MAX_FORWARDED_FD`) are rejected. Must be a non-negative integer ≥ 3. CLI: `src/engine.ts:92`. Engine: `rust/src/debug.rs:159`. |
> | `KESHA_DIARIZE_TIMEOUT_SECS` | Engine | Cap total diarization wall time (seconds). It can only cut a run short — the phase budgets still apply, so it never widens one. Unset means no overall cap. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` | Engine | Replace the 300 s budget for the CoreML model load (seconds), for a host whose cold ANE compile is legitimately slower. Does not affect the other phases. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_COMPUTE_UNITS` | Engine | CoreML compute units for the Sortformer model: `all` (default), `cpu-and-ane`, `cpu-and-gpu`, `cpu-only`. An unrecognised value fails with `E_INVALID_ARG`. Engine: `rust/src/transcribe/diarize.rs`. |
> | `KESHA_DIARIZE_MODEL_PATH` | CLI + Engine | Override the Sortformer model path. CLI: `src/engine.ts:212`. Engine: `rust/src/transcribe/mod.rs:747`. |
> | `KESHA_STATS_DB` | CLI | Override the Stats DB path (`src/stats.ts:580`). |
> | `KESHA_LOG_DIR` | CLI | Override the Diagnostic log directory (`src/diagnostic-log.ts:73`). |

#### Scenario: Ira points the cache at a network share in CI

- GIVEN `KESHA_CACHE_DIR=/mnt/ci-cache/kesha` is set
- WHEN Ira runs `kesha standup.ogg`
- THEN the CLI resolves the Engine binary from `/mnt/ci-cache/kesha/`
- AND the Engine reads models from `/mnt/ci-cache/kesha/models/`

#### Scenario: KESHA_DEBUG_FD rejects stdin/stdout/stderr numbers

- WHEN `KESHA_DEBUG_FD=1` is set
- THEN `spawnStdioWithDebugFd` returns the base stdio array unchanged (fd 1 is
  rejected)
- AND no extra fd is forwarded to the Engine

#### Scenario: KESHA_DEBUG_FD rejects out-of-range values

- WHEN `KESHA_DEBUG_FD=2000` is set
- THEN `spawnStdioWithDebugFd` returns the base stdio array unchanged
  (2000 > `MAX_FORWARDED_FD` = 1024)

> *Technical Note — `MAX_FORWARDED_FD = 1024` at `src/engine.ts:66`. The
> guard condition at `src/engine.ts:95`:
> `!Number.isInteger(fd) || fd < 3 || fd > MAX_FORWARDED_FD`.*
