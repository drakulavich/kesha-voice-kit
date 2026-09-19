## 1. Surface

- [ ] 1.1 Rewrite `src/lib.ts` to the D1 surface; `transcribe` returns `TranscribeResult`
- [ ] 1.2 `install()` over `installEngine`; delete `downloadModel`, `downloadEngine` export, `downloadCoreML`, `downloadTts`
- [ ] 1.3 `capabilities()` over the cached `describe`
- [ ] 1.4 Replace `SayError` with `KeshaError` keeping `exitCode` and `stderr`; every rejection path constructs one

## 2. Tests and docs

- [ ] 2.1 `tests/unit/lib.test.ts`: the three scenarios per requirement above; delete the alias tests
- [ ] 2.2 `docs/api.md` rewritten with a rename table; `docs/architecture.md:265`, `CLAUDE.md:207`, GLOSSARY "Core API" entry updated
- [ ] 2.3 CHANGELOG "Breaking" section for 2.0.0
