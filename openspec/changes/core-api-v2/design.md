## Context

Baseline `programmatic-api` on `main` after #1260 and #1273: `transcribe -> Promise<string>`, `transcribeWithTimestamps`, the alias `transcribeWithSegments`, `downloadModel`/`downloadEngine` (the same function), `downloadCoreML`, `downloadTts`, `toToon`, `hasErrorRecords`, `KeshaError`, and `SayError` (`src/synth.ts`, already a `KeshaError` subclass), all in `src/lib.ts`. `transcribe` already rejects a missing file with `KeshaError` `E_INPUT_NOT_FOUND` and a directory with `E_INVALID_ARG` before any spawn. Every Engine spawn goes through `runEngineProcess` in `src/engine/spawn.ts`; a missing Engine reaches a Core API caller as `KeshaError` `E_ENGINE_SPAWN` whose `hint` is `spawnHint()` ("run `kesha install`", or the `KESHA_ENGINE_BIN` variant). The MCP `transcribe_audio` tool imports `transcribe` and `transcribeWithTimestamps` from `src/lib.ts`.

References to the removed names outside `src/` and tests: `docs/api.md`, `docs/architecture.md` (Integration surfaces), `docs/errors.md` (`SayError.code`), `CLAUDE.md` (Non-obvious wiring), `openspec/specs/programmatic-api/spec.md`, `openspec/specs/GLOSSARY.md` (Core API entry), `openspec/specs/mcp-server/spec.md`, `openspec/specs/engine-contract/spec.md`, `openspec/specs/tts-synthesis/spec.md`, `openspec/changes/engine-version-override/design.md`, and comments naming the internal `downloadEngine` in `.github/` and `flake.nix`.

## Goals / Non-Goals

Goals: names say what they do; one result shape; one error type. Non-goals: as in the proposal.

## Decisions

### D1. Surface

```ts
export function transcribe(path: string, opts?: TranscribeOptions): Promise<TranscribeResult>;
export function say(opts: SayOptions): Promise<Uint8Array>;
export function install(opts?: InstallOptions): Promise<void>;
export function capabilities(): Promise<EngineDescription>;
export function toToon(results: TranscribeResult[], errors?: TranscribeErrorRecord[]): string;
export function hasErrorRecords(output: TranscribeJsonOutput): output is { results; errors };
export class KeshaError extends Error { readonly code: string; readonly hint?: string; readonly exitCode?: number; readonly stderr?: string; /* origin, versionMismatch as today */ }
export interface InstallOptions { tts?: string[]; vad?: boolean; diarize?: boolean; noCache?: boolean; backend?: "coreml" | "onnx"; engineVersion?: string }
export type EngineDescription = DescribeDocument;
export type { TranscribeOptions, TranscribeResult, TranscribeErrorRecord, TranscribeJsonOutput, TranscriptionSegment, WordTiming, SayOptions, VadMode, EngineDescription, InstallOptions };
```

`install()` with no options installs the Engine and ASR models, exactly what `kesha install` does. Each field is one `kesha install` flag: `tts: ["en"]` is `--tts en` (an empty or absent list installs no TTS; the CLI's bare `--tts` has no API counterpart because the caller names the languages), `vad` is `--vad`, `diarize` is `--diarize`, `noCache` is `--no-cache`, `backend` is `--coreml`/`--onnx`, `engineVersion` is `--engine-version`. `--plan` is not mirrored: it prints a preview and installs nothing, and `install()` is the explicit download call. `install()` makes the same refusals the CLI makes before any download, with the same codes: a malformed `engineVersion` or a `backend` this platform cannot run is `E_INVALID_ARG`, a TTS language the platform cannot serve is `E_INVALID_ARG`, `diarize` off darwin-arm64 is `E_UNSUPPORTED_PLATFORM`.

The proposal's `engine?: boolean` field is dropped: `kesha install` has no flag that skips the Engine, `installEngine` always ensures it (a valid cache is a no-op), and `downloadTts` installed it too. An option with no behaviour behind it is a speculative field.

The never-auto-download rule is unchanged: `transcribe` and `capabilities` reject with `E_ENGINE_SPAWN` and a `hint` naming `kesha install` when the Engine is missing; `say` rejects with `E_ENGINE_SPAWN`, `exitCode` 1, and the setup hint in its message, exactly as the CLI prints it. None of them calls `install`.

### D2. `transcribe` result

`transcribe` resolves to a `TranscribeResult`, the type the CLI emits under `--json` for one file: `file`, `text`, `lang`, `sttTimeMs`, `textLanguage` when the text has a detectable language, and `segments` only when `opts.timestamps` or `opts.speakers` is set. A missing file rejects with `KeshaError` `E_INPUT_NOT_FOUND` before any spawn; a directory with `E_INVALID_ARG`.

`lang` and `textLanguage` come from the CLI-side `tinyld` detector (`source: "tinyld"`), routed through the same `routeLanguage` floor the CLI applies. The API does not run the Engine's audio language ID or the macOS text detector: each would be one more Engine spawn per call, and both print their failures to the caller's stderr, which the requirement forbids. `audioLanguage` is therefore absent, and on macOS `lang` can differ from what `kesha --json` reports for the same file. The shape is the contract; the CLI remains the place for full language detection.

### D3. Errors

`KeshaError` is the only rejection type. `code` is an Error code the Engine publishes: an Engine code passed through, or one the CLI raises itself, which `tests/unit/capabilities-pact.test.ts` requires to be published with origin `cli` or `both`. `hint` is the remedy the CLI would print. `SayError` is removed; `say` constructs `KeshaError` with the same `code`, `exitCode` and `stderr` it carried — `exitCode` is set whenever an Engine subprocess ran or a pre-flight assigned one (2 for empty text or a NUL byte, 5 for text too long, 1 for a missing Engine, 130 for an abort), so callers branching on them keep working.

Every exported async function wraps its body so a failure nothing coded (a plain `Error` from the installer's download path, for instance) rejects as `KeshaError` `E_INTERNAL` carrying the original message. `E_INTERNAL` is the only catch-all the Engine publishes as `both`; `E_MODEL_DOWNLOAD` would describe a download failure better, but it is `engine`-origin and the CLI may not raise it.

### D4. MCP and CLI stay byte-identical

The CLI never imports `src/lib.ts`. The MCP `transcribe_audio` tool does, and renders failures through `errorMessage`, which prints a `KeshaError` with its code; routing it through the new wrapper would turn a plain failure message into `error [E_INTERNAL]: …` and add the `tinyld` pass. The tool therefore calls the internal `assertAudioFileArgument` and `transcribeWithSegments` from `src/transcribe.ts`, the same two steps the old `transcribe`/`transcribeWithTimestamps` ran, so its responses do not change. `SayError`'s removal changes one internal record: the local stats database stores `error_class` `KeshaError` instead of `SayError` for a failed `say`; nothing prints that column while `error_code` is set, and it always is.

## Risks / Trade-offs

- Every existing programmatic caller breaks on 2.0.0. Accepted and announced in CHANGELOG "Breaking"; the rename map is one table in `docs/api.md`.
- `lang` from the API can differ from `kesha --json` on macOS (D2). Documented in `docs/api.md`.

## Migration Plan

One PR: `src/lib.ts` rewrite, `docs/api.md` rewrite with the migration table, `CLAUDE.md`, `docs/architecture.md`, `docs/errors.md`, GLOSSARY entry, tests. The table records that `SayError` becomes `KeshaError` with `code`, `exitCode` and `stderr` unchanged, so a caller that branched on `err.exitCode` needs only the type name changed. `package.json#version` is not bumped here; the 2.0.0 release does that.

## Open Questions

- None.
