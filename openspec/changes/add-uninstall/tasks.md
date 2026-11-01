## 1. Plan

- [x] 1.1 `src/uninstall-plan.ts`: build `UninstallEntry[]` by the design.md ownership table: only Kesha-named entries are `remove`, each directory only if then empty; both candidates of every FluidAudio subsystem; `recordings/` is `remove`; foreign entries and an outside `KESHA_ENGINE_BIN` are `keep`
- [x] 1.2 Unit tests over a temp home: default layout, `KESHA_HOME` plus `KESHA_LOG_DIR`, `KESHA_LOG_DIR` at a shared directory, Stats `-wal`/`-shm`, a planted file in the cache (kept) and a recovery recording (removed), a foreign entry and a partial legacy Parakeet in a FluidAudio root, nothing installed

## 2. Command

- [x] 2.1 `src/cli/uninstall.ts`: print the plan, ask once in a terminal, `--yes`, refuse when stdin or stdout is not a TTY, take the install lock of the Engine path without waiting and fail when it cannot, remove the `remove` entries, report `E_UNINSTALL_PARTIAL` and continue past a failure, exit 1
- [x] 2.2 Register it in `src/cli/main.ts`; `bun run generate:shell-artifacts`
- [x] 2.3 cli-contracts cases: stdout empty on every outcome; exit 0 on success; exit 2 on refusal, once with stdin not a TTY and once with only stdout piped; exit 1 on a held lock and on an unlockable path, nothing removed; exit 1 on a read-only entry with the other entries removed

## 3. Docs

- [x] 3.1 `docs/architecture.md:275` and the README point at `kesha uninstall`
- [x] 3.2 `docs/errors.md` row for `E_UNINSTALL_PARTIAL`; the `kesha status --disk` reset hint names `kesha uninstall`
- [x] 3.3 `rust/src/protocol/describe.rs::CLI_ONLY` publishes `E_UNINSTALL_PARTIAL`; `tests/unit/capabilities-pact.test.ts` lists it as not yet recorded and fails once a re-recorded pact carries it

## 4. Protected removal

- [x] 4.1 Removal walks around protected paths (every `keep` entry and the lock), reports every non-missing, non-empty rm/rmdir failure as `E_UNINSTALL_PARTIAL`, and removes empty state directories on every run that is not refused; cli-contracts cases for a log directory inside `models/`, an emptied directory under a read-only parent and a run with only empty directories left; a test that the lock survives the removal of `engine/`
- [x] 4.2 A symbolic link is never walked; one leading to the lock is removed as a link after release. With nothing left to remove, empty directories go only with `--yes`; without it stderr names them. A unit test for the link and cli-contracts cases for both empty-directory outcomes
- [x] 4.3 A link leading to the lock stays and is `E_UNINSTALL_PARTIAL`; with `--yes` and nothing left to remove, every empty state directory goes, a parent emptied by its children included

## Definition of Done

- [x] `bun bin/kesha.js uninstall --help` exits 0 and prints usage naming `--yes`
- [x] `bun bin/kesha.js uninstall </dev/null | cat` exits 2 with `E_INVALID_ARG` naming `kesha uninstall --yes`, and the cache under the test's `KESHA_HOME` is unchanged
- [x] `bun test tests/unit/uninstall-plan.test.ts --randomize` passes, covering every scenario in the delta; `just mutate` on the foreign-entry check reports PINNED
- [x] `bun test tests/integration/cli-contracts.test.ts --randomize` passes with the uninstall cases, including the read-only entry (exit 1, `E_UNINSTALL_PARTIAL`, the other entries gone); `just mutate` turning continue-past-failure into a stop reports PINNED
- [ ] On the maintainer's Mac, after `kesha uninstall --yes`, `kesha status --disk` lists no Kesha component and no external root with Kesha files
- [ ] `openspec validate add-uninstall --strict` and `bun run check:fast` pass
