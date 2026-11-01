## 1. Plan

- [ ] 1.1 `src/uninstall-plan.ts`: build `UninstallEntry[]` by the design.md ownership table: only Kesha-named entries are `remove`, each directory only if then empty; both candidates of every FluidAudio subsystem; `recordings/`, foreign entries and an outside `KESHA_ENGINE_BIN` are `keep`
- [ ] 1.2 Unit tests over a temp home: default layout, `KESHA_HOME` plus `KESHA_LOG_DIR`, `KESHA_LOG_DIR` at a shared directory, Stats `-wal`/`-shm`, a planted file and a recording in the cache, a foreign entry and a partial legacy Parakeet in a FluidAudio root, nothing installed

## 2. Command

- [ ] 2.1 `src/cli/uninstall.ts`: print the plan, ask once in a terminal, `--yes`, refuse when stdin or stdout is not a TTY, take the install lock of the Engine path without waiting and fail when it cannot, remove the `remove` entries, report `E_UNINSTALL_PARTIAL` and continue past a failure, exit 1
- [ ] 2.2 Register it in `src/cli/main.ts`; `bun run generate:shell-artifacts`
- [ ] 2.3 cli-contracts cases: stdout empty on every outcome; exit 0 on success; exit 2 on refusal, once with stdin not a TTY and once with only stdout piped; exit 1 on a held lock and on an unlockable path, nothing removed; exit 1 on a read-only entry with the other entries removed

## 3. Docs

- [ ] 3.1 `docs/architecture.md:275` and the README point at `kesha uninstall`
- [ ] 3.2 `docs/errors.md` row for `E_UNINSTALL_PARTIAL`; the `kesha status --disk` reset hint names `kesha uninstall`

## Definition of Done

- [ ] `bun bin/kesha.js uninstall --help` exits 0 and prints usage naming `--yes`
- [ ] `bun bin/kesha.js uninstall </dev/null | cat` exits 2 with `E_INVALID_ARG` naming `kesha uninstall --yes`, and the cache under the test's `KESHA_HOME` is unchanged
- [ ] `bun test tests/unit/uninstall-plan.test.ts --randomize` passes, covering every scenario in the delta; `just mutate` on the foreign-entry check reports PINNED
- [ ] `bun test tests/integration/cli-contracts.test.ts --randomize` passes with the uninstall cases, including the read-only entry (exit 1, `E_UNINSTALL_PARTIAL`, the other entries gone); `just mutate` turning continue-past-failure into a stop reports PINNED
- [ ] On the maintainer's Mac, after `kesha uninstall --yes`, `kesha status --disk` lists no Kesha component and no external root with Kesha files
- [ ] `openspec validate add-uninstall --strict` and `bun run check:fast` pass
