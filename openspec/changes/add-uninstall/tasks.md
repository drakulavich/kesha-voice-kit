## 1. Plan

- [ ] 1.1 `src/uninstall-plan.ts`: build `UninstallEntry[]` from `resolveStatePaths`, `audioDir`, `fluidSubsystemDirs` and the unread Parakeet copy; mark foreign top-level entries, `recordings/` and an outside `KESHA_ENGINE_BIN` as `keep`
- [ ] 1.2 Unit tests over a temp home: default layout, `KESHA_HOME` plus `KESHA_LOG_DIR`, a planted file in the cache, a foreign entry in a FluidAudio root, nothing installed

## 2. Command

- [ ] 2.1 `src/cli/uninstall.ts`: print the plan, ask once in a terminal, `--yes`, refuse without a TTY, take the install lock without waiting, remove the `remove` entries, continue past a failure and exit 1
- [ ] 2.2 Register it in `src/cli/main.ts`; `bun run generate:shell-artifacts`
- [ ] 2.3 cli-contracts cases: stdout empty, exit codes 0/1/2, nothing removed on refusal and on a held lock

## 3. Docs

- [ ] 3.1 `docs/architecture.md:275` and the README point at `kesha uninstall`
- [ ] 3.2 `docs/errors.md` rows for any new message

## Definition of Done

- [ ] `bun bin/kesha.js uninstall --help` exits 0 and prints usage naming `--yes`
- [ ] `bun bin/kesha.js uninstall </dev/null` exits 2 with `E_INVALID_ARG` naming `kesha uninstall --yes`, and the cache under the test's `KESHA_HOME` is unchanged
- [ ] `bun test tests/unit/uninstall-plan.test.ts --randomize` passes, covering every scenario in the delta; `just mutate` on the foreign-entry check reports PINNED
- [ ] `bun test tests/integration/cli-contracts.test.ts --randomize` passes with the uninstall cases
- [ ] On the maintainer's Mac, after `kesha uninstall --yes`, `kesha status --disk` lists no Kesha component and no external root with Kesha files
- [ ] `openspec validate add-uninstall --strict` and `bun run check:fast` pass
