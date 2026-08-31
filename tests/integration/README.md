# Integration suites

Behaviour that crosses the CLI or the engine boundary is tested here. Most suites drive a **fake
engine** — a shell script the suite writes itself and points `KESHA_ENGINE_BIN` at — and run
everywhere. A few need a **real** engine, and those must say so, because the fast CI lane
(`integration-tests` in `ci.yml`) has no engine and never downloads the 2.4 GB model bundle.

## The guard convention

A suite that needs a real engine gates on the dependency it actually has:

| The suite needs | Gate on | Suites |
| --- | --- | --- |
| a functional installed engine | `engineGate()` from `tests/helpers/model-gate.ts` | `e2e-engine`, `mcp-e2e` |
| a source-built engine plus the Kokoro stand-in | `KOKORO_MODEL` / `KOKORO_VOICE` and `rust/target/release/kesha-engine` | `say-e2e`, `mcp-synthesis-e2e` |

`engineGate()` asks the binary to describe itself rather than checking that a file exists: the #796
stub existed, ran, and answered nothing, which un-skipped a suite and surfaced as a JSON parse crash
(#801). The source-built path is in the second gate deliberately — the Kokoro stand-in is committed,
so a model-only gate would run those suites in lanes that never build the binary (#741).

Either shape is fine:

```ts
describe.skipIf(!engineInstalled)("e2e-engine", () => { … });   // whole suite
it.skipIf(!SPIKE_AVAILABLE)("produces valid WAV", async () => { … });  // case by case
```

The second shape is the one that erodes: a case added next to three guarded ones inherits nothing.

## Skipping is not always allowed

A lane that installed an engine must not then skip the suites that were the reason to install it —
that is a green run of nothing (#741). So `engineGate()` returns a `requiredFailure` when
`KESHA_REQUIRE_MODEL_TESTS` is set and the engine is unusable, and the suite raises it as a named
failing case. `mcp-synthesis-e2e` does the same for a lane that named `KOKORO_MODEL` (#857).

## What enforces this

`tests/unit/model-suite-guards.test.ts` — the TS mirror of `rust/tests/model_gate.rs`. It reads
every `*.test.ts` here, decides which ones drive a real engine, and fails when one declares a case
no guard covers, naming the file, the line and the fix.

Detection is conservative on purpose, since a lint that misfires gets ignored. A suite counts as
real-engine only when it **imports** `engineGate`/`modelsRequired` from `tests/helpers/model-gate.ts`
or `getEngineBinPath` from `src/engine`, or names the source-built engine path. A suite that reaches
the engine some other way is invisible to it, as is a case wrapped in a conditional block — that is
the `requiredFailure` shape above.

Running ungated is still available; it just has to be deliberate now. Add the suite to
`UNGATED_BY_DESIGN` in that file with a one-line reason, and the loud CI signal is yours.

## No suite may leave a process running

`bunfig.toml` preloads `tests/helpers/leak-guard.ts` into every suite, so a stub that outlives the
test that spawned it fails the run and is reaped rather than sitting in `ps` for days (#1003). It
reaps twice: after each test, the pids `waitForPidFile` handed out — that is every fake engine
announcing itself — and after each file, every descendant the runner still has, which is how an
engine spawned in-process gets caught. Signal escalates SIGTERM → SIGKILL, because the fixtures
worth catching are the ones that trap SIGTERM.

Nothing to do at a call site: `waitForPidFile` tracks what it returns. Only descendants and pids a
test actually saw are ever signalled, so a parallel lane's processes are out of reach by
construction.

A run killed outright — Ctrl+C on the harness, a timed-out CI step, an interrupted agent session —
reaches neither hook, so a fixture that traps SIGTERM outlives every reaper there is; fifteen of
them accumulated at `PPID=1` over two days, the oldest at 45 hours, and only `kill -9` cleared them
(#1131). Signal-immune fixtures therefore have to end themselves: build the command with
`stubbornShell()` from `tests/helpers/process.ts`, which keeps the immunity the escalation is tested
against and adds a five-minute clock. `tests/unit/process-leak-guard.test.ts` scans `tests/` and
`rust/src/` for the unbounded shape and fails naming the file and line.
