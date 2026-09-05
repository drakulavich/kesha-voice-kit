# Proposal: core-api-v2

## Why

The Core API carries three aliases whose names no longer say what they do: `downloadModel` installs the Engine binary, `downloadCoreML` is a deprecated alias of it, and `transcribeWithSegments` is a deprecated alias of `transcribeWithTimestamps`. `transcribe` returns a bare string while every other consumer of a transcript (the CLI, MCP, TOON) works on the structured result. Errors reach Sona as plain `Error` with the code buried in the message, except `SayError`, which carries one.

## What Changes

- `transcribe(path, opts?)` returns `TranscribeResult`; the text is `.text`. `transcribeWithTimestamps` and `transcribeWithSegments` are removed; `opts.timestamps` selects segments.
- `install(opts?)` replaces `downloadModel`, `downloadEngine`, `downloadCoreML` and `downloadTts`; one call, one options object mirroring `kesha install` flags.
- `capabilities()` exposes the `describe` document.
- Every rejection is a `KeshaError` with `code` and, when known, `hint`; `SayError` becomes `KeshaError`, keeping `exitCode` and `stderr`.
- The exported types drop `TranscriptionOutput` and add `EngineDescription`; `TranscribeResult` and the `kesha status --json` shape are unchanged.
- Ships in CLI 2.0.0.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `programmatic-api`: `transcribe` returns a structured result; installer functions collapse into `install`; `capabilities()` and `KeshaError` are added; the exported type list changes.

## Impact

`src/lib.ts`, `src/transcribe.ts`, `src/synth.ts`, `src/engine-install.ts` (signature only), `docs/api.md`, `docs/architecture.md:265`, `CLAUDE.md:207`, `openspec/specs/GLOSSARY.md:53` (Core API entry), `CHANGELOG.md`, `tests/unit/lib.test.ts`; the in-flight `engine-version-override` change references `downloadModel` in its design and is updated when it lands or archived.

## Non-goals

- Changing `TranscribeResult`, `TranscribeErrorRecord`, `TranscribeJsonOutput` or the TOON encoding.
- Adding new capabilities to the API (streaming, recording); those are separate proposals.
- Keeping deprecated aliases: 2.0.0 is the major release that removes them.
