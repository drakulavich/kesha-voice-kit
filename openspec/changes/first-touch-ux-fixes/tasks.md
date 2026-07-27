# Tasks: first-touch-ux-fixes

## 1. CLI guards (PR lane 1 — `fix-ux-cli`)

- [ ] 1.1 Add installed-engine guard to `src/cli/record.ts` (mirror `src/transcribe.ts` guard + `installHint()`), exit 1, unit test
- [ ] 1.2 Wrap engine spawn in `src/engine.ts::recordEngine` (and sibling bare spawns) as `E_ENGINE_SPAWN` with path/cause/hint, unit test
- [ ] 1.3 Add `isEngineInstalled()` guard to `src/mcp/voices.ts::listVoices` with synth-style hint, unit test
- [ ] 1.4 Reject directory positionals before progress output (`<path>: is a directory (expected an audio file)`), unit test
- [ ] 1.5 Wire `src/suggest-command.ts` into the unknown-token path with the full subcommand list + transcribe special case, unit tests
- [ ] 1.6 Gate `bun test && bunx tsc --noEmit`, commit

## 2. Onboarding docs (PR lane 2 — `fix-ux-docs`)

- [x] 2.1 README Quick Start: size/time note beside `kesha install`, `--plan` line, `kesha init` mention, PATH note (`exec $SHELL -l`), `kesha --version` check
- [x] 2.2 README: `kesha record --out hello.wav` step with mic-permission note + no-mic alternative; `status --disk` in the STT block
- [x] 2.3 README: fix TTS block (bare `--tts` = English-only, real sizes, `--tts en ru` example); fix "~20MB binary" figure; honest Windows line (blocked, issue link)
- [x] 2.4 `src/cli/install.ts` `--tts` flag help text corrected (English ~326 MB; add codes for more)
- [x] 2.5 `docs/linux-packages.md`: tag-less `gh release download` + no-gh fallback + glibc note + "what Linux gets" summary (link from docker/nix docs)
- [x] 2.6 `docs/docker.md`: amd64-only note, volume size, file-in/file-out (no mic), `--tts` step
- [x] 2.7 Fix stale/dead references: `docs/tts.md` output-format paragraph, `docs/errors.md` Stats link + platform-matrix pointer, `docs/use-cases.md` install anchor, `docs/nix-install.md` size note, `docs/product-positioning.md` Windows rows
- [x] 2.8 Gate `bun test && bunx tsc --noEmit`, commit

## 3. Raycast extension (PR lane 3 — `fix-ux-raycast`)

- [x] 3.1 Rewrite `notFoundMessage()` as numbered brew-first steps incl. `kesha install`; adjust kesha-bin tests
- [x] 3.2 Add ActionPanel to the error Detail (copy error / open preferences / setup guide URL)
- [x] 3.3 Preflight via deps seam: probe CLI version + engine availability before recording; finish-setup error state with `hint`; controller tests
- [x] 3.4 Treat `"unavailable"` meter state as silence in the tracker + ~8 s no-signal timeout surfacing the mic-permission message; constant in `dictation-config.ts`; tests
- [x] 3.5 Gate `npm test && npm run lint`, commit

## 4. MCP onboarding (PR lane 4 — `fix-ux-mcp`)

- [x] 4.1 `docs/mcp.md`: Prerequisites section above the first snippet; PATH caveat + absolute-path `command` example
- [x] 4.2 `src/mcp/tools.ts`: `transcribe_audio` absolute-path description + cwd-resolution error text, unit test
- [x] 4.3 Gate `bun test && bunx tsc --noEmit`, commit

## 5. Land

- [ ] 5.1 Push four branches, open PRs, pass CI + Greptile + grok review per lane
- [ ] 5.2 Include this OpenSpec change dir in the docs-lane PR; sync/archive after merge
