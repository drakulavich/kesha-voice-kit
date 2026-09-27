# Proposal: core-api-v2

## Why

The Core API carries three aliases whose names no longer say what they do: `downloadModel` installs the Engine binary, `downloadCoreML` is a deprecated alias of it, and `transcribeWithSegments` is a deprecated alias of `transcribeWithTimestamps`. `transcribe` returns a bare string while every other consumer of a transcript (the CLI, MCP, TOON) works on the structured result. `KeshaError` already exists, but `say` still rejects with its `SayError` subclass, and a failure nothing coded (a network error inside the installer, say) still reaches the caller as a bare `Error`.

## What Changes

- `transcribe(path, opts?)` returns `TranscribeResult`; the text is `.text`. `transcribeWithTimestamps` and `transcribeWithSegments` are removed; `opts.timestamps` selects segments.
- `install(opts?)` replaces `downloadModel`, `downloadEngine`, `downloadCoreML` and `downloadTts`; one call, one options object mirroring the `kesha install` flags (`--tts <langs>`, `--vad`, `--diarize`, `--no-cache`, `--coreml`/`--onnx`, `--engine-version`).
- `capabilities()` exposes the `describe` document as `EngineDescription`.
- Every rejection is a `KeshaError` with `code` and, when known, `hint`; `SayError` is removed, and its `code`, `exitCode` and `stderr` carry over on `KeshaError` unchanged. An uncoded failure becomes `E_INTERNAL`, the one catch-all code the Engine publishes with origin `both`.
- The exported types drop `TranscriptionOutput` and add `InstallOptions` and `EngineDescription`; `TranscribeResult` and the `kesha status --json` shape are unchanged.
- The CLI, the MCP server and TOON behave exactly as before; the MCP `transcribe_audio` tool calls the internal transcription path instead of the public facade.
- Breaking for programmatic callers, so it ships in the next major CLI release, 2.0.0 (the CLI is at 1.32.0 today). The version bump belongs to the release process, not to this change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `programmatic-api`: `transcribe` returns a structured result; installer functions collapse into `install`; `capabilities()` is added; `SayError` leaves; the exported type list changes.

## Impact

`src/lib.ts`, `src/transcribe.ts`, `src/synth.ts`, `src/engine-install.ts` (the unused `downloadEngine` wrapper goes), `src/language-routing.ts` (gains the tinyld text detector the CLI already used), `src/mcp/tools.ts` (import only), `docs/api.md` (with the migration table), `docs/architecture.md`, `docs/errors.md`, `CLAUDE.md` (the public-API line), `openspec/specs/GLOSSARY.md` (Core API entry), `CHANGELOG.md`, `tests/unit/lib.test.ts`; the in-flight `engine-version-override` change references `downloadModel` in its design and is updated when it lands or archived.

## Non-goals

- Changing `TranscribeResult`, `TranscribeErrorRecord`, `TranscribeJsonOutput` or the TOON encoding.
- Adding new capabilities to the API (streaming, recording); those are separate proposals.
- Keeping deprecated aliases: 2.0.0 is the major release that removes them.
- Changing what the CLI prints: `kesha say` without an Engine keeps its message-embedded hint, and the CLI never goes through `src/lib.ts`.
