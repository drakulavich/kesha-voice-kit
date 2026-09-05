## Context

Baseline `programmatic-api`: `transcribe -> Promise<string>` (`src/lib.ts:44`), `transcribeWithTimestamps` (`src/lib.ts:55`), alias `transcribeWithSegments` (`src/lib.ts:74`), `downloadModel`/`downloadEngine`/`downloadCoreML` (`src/lib.ts:11,42`), `downloadTts` (`src/lib.ts:37`), `SayError` (`src/synth.ts`). The only external references to the removed names outside `src/` and tests: `docs/api.md:7-9`, `docs/architecture.md:265`, `CLAUDE.md:207`, `openspec/specs/programmatic-api/spec.md:78-184`, `openspec/specs/GLOSSARY.md:53`, `openspec/changes/engine-version-override/design.md:129-131`, `CHANGELOG.md:123,175`.

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
export class KeshaError extends Error { readonly code: string; readonly hint?: string }
export type InstallOptions = { engine?: boolean; tts?: string[]; vad?: boolean; diarize?: boolean; noCache?: boolean; engineVersion?: string };
export type { TranscribeOptions, TranscribeResult, TranscribeErrorRecord, TranscribeJsonOutput, TranscriptionSegment, WordTiming, SayOptions, VadMode, EngineDescription };
```

`install()` with no options installs the Engine and ASR models, exactly what `kesha install` does; `tts: ["en"]` mirrors `--tts en`. The never-auto-download rule is unchanged: `transcribe` and `say` throw `E_ENGINE_SPAWN` with a hint when the Engine is missing and never call `install`.

### D2. `transcribe` result

`transcribe` resolves to the same `TranscribeResult` the CLI emits under `--json` for one file: `file`, `text`, `lang`, optional `audioLanguage`, `textLanguage`, `segments`, `sttTimeMs`. With `opts.timestamps` or `opts.speakers`, `segments` is populated; otherwise it is absent. A missing file rejects with `KeshaError` `E_INPUT_NOT_FOUND` before any spawn.

### D3. Errors

`KeshaError` is the only rejection type. `code` is a published Error code (Engine or CLI origin, both listed by `describe`); `hint` is the remedy the CLI would print. `SayError` is removed; its `code` semantics carry over unchanged.

## Risks / Trade-offs

- Every existing programmatic caller breaks on 2.0.0. Accepted and announced in CHANGELOG "Breaking"; the rename map is one table.

## Migration Plan

Stage 4, one PR: `src/lib.ts` rewrite, `docs/api.md` rewrite with the rename table, `CLAUDE.md:207`, `docs/architecture.md:265`, GLOSSARY entry, tests.

## Open Questions

- None.
