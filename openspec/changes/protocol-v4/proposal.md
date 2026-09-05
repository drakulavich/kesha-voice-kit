# Proposal: protocol-v4

## Why

The CLI and the Engine talk through four ad-hoc conventions: a regex over stderr for the Error code, a string prefix (`diarize: `) for progress, a separately forwarded file descriptor for the debug timeline, and two flags (`--capabilities-json`, `--error-codes-json`) that the CLI must hand-mirror in `preflight*` functions and a TS-side code registry with a drift test. The CLI parses `protocolVersion` but never gates on it — a stub answering `2` passes today. Each new Engine flag touches nine runtime files because nothing declares which flags a subcommand accepts (design spec section 5).

## What Changes

- **stdout carries payload only**; everything else the Engine says goes to stderr as NDJSON, one object per line with a `kind` of `progress`, `warn`, `error` or `debug`. The CLI renders these for humans; the Engine never prints prose.
- **`kesha-engine describe`** replaces `--capabilities-json` and `--error-codes-json` with one document: `protocolVersion: 4`, `backend`, `profile`, every subcommand with its flags and gates, the Error code taxonomy, TTS languages.
- **The protocol version becomes a gate**: a `describe` reporting any version other than 4 is an actionable Error code, not a silent success.
- **One error class on the CLI side**, `KeshaError { code, hint }`, for Engine-reported and CLI-native failures; the CLI-native codes join the taxonomy `describe` publishes and the drift test disappears.
- **`KESHA_DEBUG_FD` is removed**; the debug timeline rides the same stream as `kind: "debug"`.
- **`say --stdin-loop`** keeps its stdin framing; its status lines move to the event stream.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `engine-contract`: Capabilities JSON and the error-code flag are replaced by `describe`; stderr becomes an event stream; the version is gated; TS-native codes fold into the published taxonomy; `KESHA_DEBUG_FD` is removed; the cache requirement keys on the `describe` document.

## Impact

- Engine: `rust/src/main.rs`, `rust/src/capabilities.rs`, `rust/src/errors.rs`, `rust/src/debug.rs`, every `eprintln!` site (84 calls in 21 files), `rust/src/say_loop.rs`.
- CLI: `src/engine.ts`, `src/synth.ts`, `src/transcribe.ts`, `src/error-codes.ts`, `src/doctor.ts`, `src/cli/main.ts`.
- Direct protocol consumers that migrate with the Engine: `.github/scripts/record-capability-pacts.ts` and `tests/fixtures/capabilities/*.json`, `.github/scripts/release-install-smoke.sh`, `rust/tests/error_codes_cli.rs`, `rust/tests/diarize_e2e.rs`, `rust/tests/kokoro_rate_e2e.rs`, `rust/tests/tts_smoke.rs`, `rust/tests/debug_ndjson_fd.rs`, `docs/errors.md`.
- Not affected: `kesha status --json` (a CLI contract Raycast reads; unchanged shape), OpenClaw and Hermes (CLI only).

## Non-goals

- Changing the audio bytes `say` writes to stdout, the `TranscribeResult` JSON shape, or any `kesha` (CLI) flag.
- A "human" output mode for `kesha-engine` run by hand; `kesha` is the human interface.
- Streaming transcripts or any new Engine feature; this is a transport change only.
