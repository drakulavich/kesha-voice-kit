# Design: first-touch-ux-fixes

## Approach

Four independent PR lanes, one per surface, so each lands through the normal CI + Greptile gate without cross-conflicts. All fixes reuse mechanisms the codebase already has — no new abstractions.

## Lane 1 — CLI guards (TS, `src/`)

- **record guard**: `src/cli/record.ts` adopts the exact guard pattern `src/transcribe.ts` uses (`isEngineInstalled()` + `installHint()` from `src/install-hint.ts`), printing `Error: No recording backend is installed.` + hint, exit 1.
- **E_ENGINE_SPAWN**: wrap the `Bun.spawn` call in `src/engine.ts::recordEngine` (and any sibling bare spawn that can ENOENT) with try/catch re-throwing through the same coded-error path `src/synth.ts` already uses for `E_ENGINE_SPAWN` (`src/error-utils.ts`). Message: code, attempted path, cause, hint.
- **MCP voices guard**: `src/mcp/voices.ts::listVoices` gets the `isEngineInstalled()` preflight throwing the `synth.ts`-style hint string; `src/mcp/tools.ts` already renders thrown errors as `isError` — no tools.ts change needed for this item.
- **directory check**: in the CLI input validation where "File not found" is produced, `statSync`-detect directories and fail fast with `<path>: is a directory (expected an audio file)` before progress/engine startup.
- **typo suggestions**: extend the unknown-token path in `src/cli.ts` to consult `src/suggest-command.ts` with the full subcommand list; special-case near-misses of "transcribe" with an extra line explaining transcription is `kesha <audio-file>`. Keep the existing "if this is an audio file" hint.

Tests: one unit test per guard, mirroring how the transcribe guard and suggest-command are already tested. Gate: `bun test && bunx tsc --noEmit`.

## Lane 2 — onboarding docs

Text-only edits driven by the audit findings: README Quick Start (size/time note, `--plan`, `kesha init`, PATH `exec $SHELL -l` note, `kesha record` step with the TCC mention, `status --disk`, honest Windows line, corrected TTS block and sizes, "~20MB"→real binary size); `docs/linux-packages.md` (tag-less `gh release download`, no-gh fallback, "what Linux gets" summary); `docs/docker.md` (amd64-only, volume size, file-in/file-out, `--tts` step); `docs/tts.md` stale format paragraph; `docs/errors.md` + `docs/use-cases.md` dead links; `docs/nix-install.md` size note; `docs/product-positioning.md` Windows rows; `src/cli/install.ts` `--tts` flag help text (one string). CI: docs-only paths skip heavy lanes; the one TS string keeps `bun test` relevant.

## Lane 3 — Raycast extension

- `notFoundMessage()` (kesha-bin.ts): numbered two-step text — 1) `brew install drakulavich/tap/kesha-voice-kit` (or bun alternative), 2) `kesha install` — probed paths demoted to a trailing troubleshooting sentence.
- Error `Detail` in `dictate-to-clipboard.tsx` gains an ActionPanel: Copy Error / Open Extension Preferences (`openExtensionPreferences`) / Open Setup Guide (repo raycast README URL).
- Preflight: before `setState({status:"recording"})`, the controller runs the already-written `probeKeshaVersion` (currently exported and unused) plus an engine-availability probe (a cheap `kesha status`-style call through the deps seam); failure renders an error state whose `hint` names the remaining command. Implemented through `DictationControllerDeps` so vitest fakes it.
- Early mic detection: the silence tracker treats `"unavailable"` like silence (does not reset), and the controller arms an ~8 s no-signal timer that fails the session with the existing mic-permission message text.
- Tests updated/added through the existing fake-deps harness; the upstream-mirror rule applies — focused diff, no drive-bys.

Gate: `npm test && npm run lint` in `raycast/` (npm, not bun).

## Lane 4 — MCP docs + path contract

- `docs/mcp.md`: `## Prerequisites` block (install CLI, `kesha install`, `--tts` for synth, `kesha status` verify) above the first snippet; a PATH caveat line under the snippets with an absolute-path `command` example.
- `src/mcp/tools.ts`: `transcribe_audio` arg description becomes "Absolute path…"; the not-found error for relative inputs explains cwd resolution. Unit test for the error text.

## Decisions

- Reuse `installHint()`/coded-error machinery rather than inventing new error types — consistency with `docs/errors.md` taxonomy.
- Raycast preflight goes through the deps seam (no direct spawn in the component) to keep the UI-thin / logic-in-lib convention.
- The `~8 s` no-signal window is a constant in `dictation-config.ts` next to the other timing constants.
- No Rust changes: every finding is fixable at the TS/docs/extension layer.

## Risks

- Raycast behavior changes ship upstream later — mitigated by keeping each behavior behind small, tested lib functions.
- Doc size figures can drift again — sizes quoted from `src/install-plan.ts` pinned tables, and the figures are worded approximately (~2.7 GB) to survive minor model bumps.
