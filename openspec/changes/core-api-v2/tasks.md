## 0. Reconcile with main

- [x] 0.1 Staleness check against main after #1260 and #1273: `KeshaError` is already exported and `SayError` already extends it; `transcribe` already rejects a missing file with `E_INPUT_NOT_FOUND`; `hasErrorRecords` is exported and stays; the Engine-missing hint is `spawnHint()`; the CLI is at 1.32.0; the `engine` install option has no CLI flag and is dropped, `backend` is added; proposal, design and delta spec updated

## 1. Contracts first

- [ ] 1.1 `tests/unit/lib.test.ts`, through `src/lib.ts` only: `transcribe` resolves to a `TranscribeResult` (segments only with `timestamps`); `install(opts)` forwards each option as its `kesha install` flag and refuses what the CLI refuses with the same codes; `capabilities()` resolves to the describe document; every rejection (missing file, missing Engine, uncoded install failure, empty `say` text) is a `KeshaError` with `code` and, where known, `hint`
- [ ] 1.2 Prove the key assertions PINNED with `just mutate`

## 2. Surface

- [ ] 2.1 Rewrite `src/lib.ts` to the D1 surface; `transcribe` returns `TranscribeResult` with `lang` from the `tinyld` detector (moved to `src/language-routing.ts`)
- [ ] 2.2 `install()` over `installEngine`; delete `downloadModel`, `downloadEngine`, `downloadCoreML`, `downloadTts`, `transcribeWithTimestamps`, `transcribeWithSegments` and the `TranscriptionOutput` export
- [ ] 2.3 `capabilities()` over the cached `describe`, returned as a copy
- [ ] 2.4 Replace `SayError` with `KeshaError` keeping `code`, `exitCode` and `stderr`; every exported function rejects with a `KeshaError`
- [ ] 2.5 MCP `transcribe_audio` calls the internal transcription path; `cli-contracts` and the MCP suites pass unchanged

## 3. Docs

- [ ] 3.1 `docs/api.md` rewritten with the migration table (every removed name → its replacement); `docs/architecture.md`, `docs/errors.md`, `CLAUDE.md`, GLOSSARY "Core API" entry, and the technical notes in the `mcp-server`, `engine-contract` and `tts-synthesis` specs updated
- [ ] 3.2 CHANGELOG "Unreleased" gains a BREAKING entry for the Core API
