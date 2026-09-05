## 1. Engine schema

- [ ] 1.1 Add `Describe` to `Commands` in `rust/src/main.rs` and `rust/src/protocol/describe.rs` that assembles the document from `CommandFactory::command()` plus a gate table
- [ ] 1.2 Unit test: the set of flags clap knows equals the set the gate table lists, per subcommand
- [ ] 1.3 Fold `errors::error_codes_json` and `capabilities::get_capabilities` into the document; delete the two flags

## 2. Event stream

- [ ] 2.1 `rust/src/protocol/events.rs`: `progress`, `warn`, `error`, `debug` emitters writing one JSON object per line to stderr
- [ ] 2.2 Replace every `eprintln!` in `rust/src` (84 calls, 21 files) with an emitter call; `report` in `errors.rs` emits an `error` event
- [ ] 2.3 `say --stdin-loop` status lines become events
- [ ] 2.4 Delete the `KESHA_DEBUG_FD` descriptor path in `rust/src/debug.rs`; debug lines become `debug` events

## 3. Direct consumers

- [ ] 3.1 `record-capability-pacts.ts` and `tests/fixtures/capabilities/*.json` record `describe`
- [ ] 3.2 `release-install-smoke.sh` calls `describe`
- [ ] 3.3 Rust tests `error_codes_cli.rs`, `diarize_e2e.rs`, `kokoro_rate_e2e.rs`, `tts_smoke.rs`, `debug_ndjson_fd.rs` assert on events
- [ ] 3.4 `docs/errors.md` generated from `describe`; `docs/nix-install.md` example updated

## 4. Carrier release

- [ ] 4.1 Tag `v1.25.0-beta.1`, un-draft by hand, verify `kesha install --engine-version 1.25.0-beta.1` downloads it

## 5. CLI (stage 2, tracked here for completeness)

- [ ] 5.1 Pin the beta; `src/engine/describe.ts` with cache, version gate and `validateArgv`
- [ ] 5.2 `src/engine/events.ts` parser and `KeshaError`; delete `src/error-codes.ts`, `preflight*`, `assert*Supported`, `spawnStdioWithDebugFd`
- [ ] 5.3 One PR per command: transcribe, say, install, record, MCP
