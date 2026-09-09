## 1. Engine schema

- [x] 1.1 Add `Describe` to `Commands` in `rust/src/main.rs` and `rust/src/protocol/describe.rs` that assembles the document from `CommandFactory::command()` plus a gate table
- [x] 1.2 Unit test: the set of flags clap knows equals the set the gate table lists, per subcommand
- [x] 1.3 Fold `errors::error_codes_json` and `capabilities::get_capabilities` into the document — landed with `describe` itself at 1.1: `describe` reads `get_capabilities()` for `backend`/`features`/`tts` and builds `errors` from `ErrorCode::ALL` plus the CLI-only codes, so it is a strict superset (22 codes to the flag's 19, and an `origin` field the flag never had). Deleting the two flags is **4.2's**, not this task's: 2.5 keeps them for the `KESHA_PROTOCOL` window, and `build-engine.yml`'s smoke step and the pact recorder still read `--capabilities-json` until the beta.2 pin (5.4). When 4.2 removes them, `errors::error_codes_json` loses its only caller and goes with them; `get_capabilities` stays, because `describe` is now its consumer
- [x] 1.4 Gate table rows carry `whenUngated` (`reject` by default, `drop` for `--no-expand-abbrev`) and a `gate` that is one feature or an any-of list

## 2. Event stream

- [x] 2.1 `rust/src/protocol/events.rs`: `progress`, `warn`, `error`, `debug` emitters writing one JSON object per line to stderr
- [x] 2.2 Replace every `eprintln!` in `rust/src` (84 calls, 21 files) with an emitter call; `report` in `errors.rs` emits an `error` event
- [x] 2.3 `say --stdin-loop` status lines become events — nothing to convert: `say_loop.rs` writes only the framed binary response on **stdout** (`<status:u8><id:u32><len:u32><payload>`), and has no `eprintln!` here or at the `v1.25.0-beta.1` tag. Its `status` is a wire byte the CLI reads, not a stderr line; moving it would break the response protocol. Whatever prose the loop once had went with 2.2's sweep
- [ ] 2.4 Debug lines become `debug` events — **done**: `trace_fmt` emits `Event::Debug` and `dtrace!` goes through it. Deleting the `KESHA_DEBUG_FD` descriptor path is **4.2's**, for the same reason as 1.3: 2.5 keeps the sink whenever `KESHA_PROTOCOL` is unset. What remains for 4.2 is `dtrace_json!`, whose six call sites in `transcribe/` still write NDJSON to the fd instead of emitting a `debug` event, plus `rust/tests/debug_ndjson_fd.rs`. The CLI already forwards nothing — `protocol-literals.test.ts` pins that `KESHA_DEBUG_FD` is unreferenced in `src/`
- [x] 2.5 v3 renderer + `KESHA_PROTOCOL` window: keep `--capabilities-json`, `--error-codes-json`, the `error [CODE]:` line, the `diarize:` prefix and the `KESHA_DEBUG_FD` sink whenever `KESHA_PROTOCOL` is unset; `KESHA_PROTOCOL=4` selects the event stream, so `tts-e2e`'s v3 CLI keeps working against the source-built Engine

## 3. Direct consumers

- [x] 3.2 `release-install-smoke.sh` calls `describe`
- [ ] 3.3 Rust tests `error_codes_cli.rs`, `diarize_e2e.rs`, `kokoro_rate_e2e.rs`, `tts_smoke.rs`, `debug_ndjson_fd.rs` assert on events
- [x] 3.4 `docs/errors.md` checked two-way against `describe` (`rust/tests/error_codes_docs.rs`), not generated; `docs/nix-install.md` example updated

## 4. Carrier release

- [x] 4.1 Tag `v1.25.0-beta.1`, un-draft by hand, verify `kesha install --engine-version 1.25.0-beta.1` downloads it
- [ ] 4.2 Remove the `KESHA_PROTOCOL` window and cut `v1.25.0-beta.2`. Everything 1.3, 2.4 and 2.5 defer lands here:
  - the v3 renderer — the `Mode::V3` arm of `Event::render` and `events::mode()` itself
  - `--capabilities-json` and `--error-codes-json` in `cli/args.rs` and `main.rs`; `errors::error_codes_json` then has no caller left and goes too, while `capabilities::get_capabilities` stays because `describe` consumes it
  - the `KESHA_DEBUG_FD` sink in `debug.rs` (`json_sink`, `trace_json`, `json_sink_is_active`), its six `dtrace_json!` call sites — five in `transcribe/diarize.rs`, one in `transcribe/mod.rs` — which must emit `debug` events instead
  - **the terminal progress bar and the recording row ticker go with the mode, because they only ever paint under it.** `bar_paints` is `mode == Mode::V3 && in_flight == 1`, and `ListenTicker` yields `Tick::Row` only on a `Mode::V3` terminal — with the variant gone both are unreachable, so the `\r` repaint, `Tick::Row`, `end_open_bar_line` and the `BAR_LINE_OPEN` bookkeeping are dead code to remove rather than adapt. `reader_wanted` survives, reducing to its byte floor, because the reader still feeds events
  - the tests that pin the window, which are deletions rather than edits: `describe_cli.rs`'s two `…_still_answers_during_the_window` cases, `debug_events_v4.rs::v3_debug_trace_is_unchanged` (it asserts the `[debug/engine +` prose), `rust/tests/debug_ndjson_fd.rs`, `capabilities.rs`'s `assert_eq!(get_capabilities().protocol_version, 3)`, and the eleven `Mode::V3` cases in `record.rs`, `models/progress.rs` and `models/download.rs`
  - `rust/tests/no_stray_eprintln.rs`'s `ALLOWED` ledger, which names no mode and so survives any symbol search: six of its seven entries are the painter and the bar it is about to delete — the `\r` rows, the blank line closing one, the flush repainting the other, and the two `is_terminal` probes gating them. Each entry allows exactly one occurrence, so leaving them behind fails the count rather than passing quietly
  - **`build-engine.yml`'s smoke step must move to `describe` in the same PR.** It greps `--capabilities-json` output for `"tts"` on every built binary before upload, so deleting the flag without repointing it fails the release build rather than a test

## 5. CLI (stage 2, tracked here for completeness)

- [x] 5.1 Pin the beta; `src/engine/describe.ts` with cache, version gate and `validateArgv` (files created in stage 2; the `src/engine/` layout is finalised in stage 5)
- [x] 5.2 `src/engine/events.ts` parser and `KeshaError` carrying `code`, `hint`, `exitCode`, `stderr`; delete `src/error-codes.ts`, `preflight*`, `assert*Supported`, `spawnStdioWithDebugFd` (files created in stage 2; the `src/engine/` layout is finalised in stage 5)
- [ ] 5.3 One PR per command: transcribe, say, install, record, MCP — transcribe: #1161; say: #1162; install: #1165; record: #1167; MCP: #1169 (install and record spawns move to protocol 4 once the beta carrying these events is pinned)
- [ ] 5.4 `record-capability-pacts.ts` and `tests/fixtures/capabilities/*.json` record `describe`, moved here from stage 1 because they record the published Engine pin, which switches to `v1.25.0-beta.2` at 4.2

## 6. Downstream spec sweeps

- [x] 6.1 `kesha doctor` drops `KESHA_DEBUG_FD` from `KNOWN_ENV_KEYS` (`src/doctor.ts:37`); `kesha status` reads the describe document, keeping the nested capabilities value's shape
- [x] 6.2 `src/synth.ts` loses `applyNoExpandAbbrev` (`src/synth.ts:69-85`); the gate comes from `validateArgv` on its `whenUngated: drop` row
- [x] 6.3 `preflightRecordLive` (`src/engine.ts:481-505`) loses its hand-written `record.live` check to `validateArgv`, and its three bare `Error` throws become `KeshaError`
- [ ] 6.4 Sweep the Technical-Note-only mentions of the old protocol listed in the design's Open Questions
