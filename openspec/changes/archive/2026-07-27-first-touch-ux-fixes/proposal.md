# Proposal: first-touch-ux-fixes

## Why

A first-touch UX audit (empirical CLI walkthrough with a fresh cache + doc walkthroughs for four personas: macOS dev, Raycast-first, Linux, MCP/agent) found that a brand-new user hits misleading or hostile failures within the first five minutes: `kesha record` without an installed engine dumps a raw Bun stack trace (the Raycast extension's very first CLI call), `kesha install` downloads ~2.7 GB with no size warning and no progress during the model step, the README TTS block fails when copy-pasted verbatim, and a denied microphone permission costs up to 300 silent seconds in the Raycast extension before any message appears.

## What Changes

- **CLI guards**: `kesha record` gains the same installed-engine guard `transcribe` has; engine spawn failures surface as `E_ENGINE_SPAWN` with an install hint (as `docs/errors.md` already promises); MCP `list_voices`/`list_languages` gain the guard `synthesize_speech` has; passing a directory is rejected before the progress bar starts; typos of subcommand names get "did you mean" suggestions.
- **Onboarding docs**: README Quick Start states download size/time up front, surfaces `kesha install --plan` and `kesha status --disk`, mentions `kesha init` (the command interactive error hints actually recommend), adds a `kesha record` step with the macOS mic-permission note and a PATH sanity check; the TTS block is corrected (bare `--tts` is English-only, sizes fixed); Windows status is stated honestly; Linux docs get a "what Linux gets" summary and a working `.deb` download command; stale figures ("~20MB binary", "~990MB") and dead links are fixed.
- **Raycast extension onboarding**: `notFoundMessage` becomes a two-step guide that does not presume bun (Homebrew path first) and includes the mandatory `kesha install` step; the error view gains an ActionPanel (copy error / open preferences / setup guide); a preflight probe surfaces "finish setup" before recording starts; a meter that never delivers signal within ~8 s surfaces the mic-permission message immediately instead of after the full recording window.
- **MCP onboarding**: `docs/mcp.md` gains a Prerequisites section; config snippets note the GUI-client PATH caveat with an absolute-path alternative; `transcribe_audio` documents/enforces the absolute-path contract.

## Capabilities

### New Capabilities

(none — all changes modify behavior covered by existing capability specs)

### Modified Capabilities

- `audio-recording`: recording without an installed engine must fail with an actionable install hint, never a stack trace.
- `engine-contract`: any engine spawn failure surfaces as `E_ENGINE_SPAWN` with the binary path, cause, and recovery hint.
- `mcp-server`: `list_voices`/`list_languages` return structured install-hint errors when the engine is missing; `transcribe_audio` defines the path-resolution contract.
- `cli-shell-integration`: unknown-command handling suggests near-miss subcommands; directory arguments are rejected with a clear message before any work starts.
- `installation`: install UX states cost up front (docs-level; `--plan` and `status --disk` become documented user-facing commands).
- `raycast-extension`: not-found guidance, error-view actions, preflight, and early mic-permission detection.

## Impact

- TS CLI: `src/cli/record.ts`, `src/engine.ts`, `src/mcp/voices.ts`, `src/mcp/tools.ts`, `src/cli.ts`/`src/suggest-command.ts` + unit tests.
- Docs: `README.md`, `docs/mcp.md`, `docs/linux-packages.md`, `docs/docker.md`, `docs/tts.md`, `docs/errors.md`, `docs/use-cases.md`, `docs/nix-install.md`, `docs/product-positioning.md`, `src/cli/install.ts` flag help text.
- Raycast: `raycast/src/lib/kesha-bin.ts`, `raycast/src/lib/dictation-controller.ts`, `raycast/src/lib/recording-monitor.ts` or `signal-meter.ts`, `raycast/src/dictate-to-clipboard.tsx` + vitest updates (upstream-mirrored directory — keep the diff focused).
- No engine (Rust) changes. No breaking changes; error messages improve but the stdin-loop protocol is untouched.
