## 1. Engine schema

- [ ] 1.1 Add `Describe` to `Commands` in `rust/src/main.rs` and `rust/src/protocol/describe.rs` that assembles the document from `CommandFactory::command()` plus a gate table
- [ ] 1.2 Unit test: the set of flags clap knows equals the set the gate table lists, per subcommand
- [ ] 1.3 Fold `errors::error_codes_json` and `capabilities::get_capabilities` into the document; delete the two flags
- [ ] 1.4 Gate table rows carry `whenUngated` (`reject` by default, `drop` for `--no-expand-abbrev`) and a `gate` that is one feature or an any-of list

## 2. Event stream

- [ ] 2.1 `rust/src/protocol/events.rs`: `progress`, `warn`, `error`, `debug` emitters writing one JSON object per line to stderr
- [ ] 2.2 Replace every `eprintln!` in `rust/src` (84 calls, 21 files) with an emitter call; `report` in `errors.rs` emits an `error` event
- [ ] 2.3 `say --stdin-loop` status lines become events
- [ ] 2.4 Delete the `KESHA_DEBUG_FD` descriptor path in `rust/src/debug.rs`; debug lines become `debug` events
- [ ] 2.5 v3 renderer + `KESHA_PROTOCOL` window: keep `--capabilities-json`, `--error-codes-json`, the `error [CODE]:` line, the `diarize:` prefix and the `KESHA_DEBUG_FD` sink whenever `KESHA_PROTOCOL` is unset; `KESHA_PROTOCOL=4` selects the event stream, so `tts-e2e`'s v3 CLI keeps working against the source-built Engine

## 3. Direct consumers

- [ ] 3.2 `release-install-smoke.sh` calls `describe`
- [ ] 3.3 Rust tests `error_codes_cli.rs`, `diarize_e2e.rs`, `kokoro_rate_e2e.rs`, `tts_smoke.rs`, `debug_ndjson_fd.rs` assert on events
- [ ] 3.4 `docs/errors.md` checked two-way against `describe` (`rust/tests/error_codes_docs.rs`), not generated; `docs/nix-install.md` example updated

## 4. Carrier release

- [ ] 4.1 Tag `v1.25.0-beta.1`, un-draft by hand, verify `kesha install --engine-version 1.25.0-beta.1` downloads it
- [ ] 4.2 Remove the `KESHA_PROTOCOL` window (delete the v3 renderer, `--capabilities-json`, `--error-codes-json`), cut `v1.25.0-beta.2`

## 5. CLI (stage 2, tracked here for completeness)

- [ ] 5.1 Pin the beta; `src/engine/describe.ts` with cache, version gate and `validateArgv` (files created in stage 2; the `src/engine/` layout is finalised in stage 5)
- [ ] 5.2 `src/engine/events.ts` parser and `KeshaError` carrying `code`, `hint`, `exitCode`, `stderr`; delete `src/error-codes.ts`, `preflight*`, `assert*Supported`, `spawnStdioWithDebugFd` (files created in stage 2; the `src/engine/` layout is finalised in stage 5)
- [ ] 5.3 One PR per command: transcribe, say, install, record, MCP
- [ ] 5.4 `record-capability-pacts.ts` and `tests/fixtures/capabilities/*.json` record `describe`, moved here from stage 1 because they record the published Engine pin, which switches to `v1.25.0-beta.2` at 4.2

## 6. Downstream spec sweeps

- [ ] 6.1 `kesha doctor` drops `KESHA_DEBUG_FD` from `KNOWN_ENV_KEYS` (`src/doctor.ts:37`); `kesha status` reads the describe document, keeping the nested capabilities value's shape
- [ ] 6.2 `src/synth.ts` loses `applyNoExpandAbbrev` (`src/synth.ts:69-85`); the gate comes from `validateArgv` on its `whenUngated: drop` row
- [ ] 6.3 `preflightRecordLive` (`src/engine.ts:481-505`) loses its hand-written `record.live` check to `validateArgv`, and its three bare `Error` throws become `KeshaError`
- [ ] 6.4 Sweep the Technical-Note-only mentions of the old protocol listed in the design's Open Questions
