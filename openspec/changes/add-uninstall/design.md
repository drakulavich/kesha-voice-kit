## Context

`kesha status --disk` already resolves every place Kesha writes: the Model cache (`src/state-paths.ts::resolveStatePaths`), the Diagnostic log directory, the Stats DB file, the MCP audio directory (`src/mcp/audio-output.ts::audioDir`), and the FluidAudio subsystem directories inside and outside the cache (`src/fluid-roots.ts::fluidSubsystemDirs`, `fluidExternalRoots`). Uninstall reuses that resolution; it adds no new path knowledge.

## Data

One uninstall plan per run, built in memory and never written to disk:

```ts
interface UninstallEntry {
  path: string;        // absolute, resolved once at CLI start
  label: string;       // "Model cache", "Diagnostic logs", "TTS (Kokoro G2P)", ...
  bytes: number;       // dirSizeBytes / fileSize at plan time
  action: "remove" | "keep";
  reason?: string;     // for "keep": "not created by Kesha", "KESHA_ENGINE_BIN outside the Model cache"
}
```

Volume, measured on the maintainer's Mac: 4 roots, about 470 files, 5.7 GB. A plan has one entry per known location (about 12), not one per file, plus one `keep` entry per foreign top-level entry found. Sizing walks the same trees `status --disk` walks, which takes 0.52 s wall time there (`time bun bin/kesha.js status --disk`).

This table is the one list of what is removed. Every location follows one rule: remove only the entries listed here, then remove the directory itself only if it is empty. No location is removed as a whole, because a specific variable such as `KESHA_LOG_DIR` can point at a directory the user shares (`$HOME`, `/var/log`).

| Location | Removed (everything else is `keep` and named) |
|---|---|
| Model cache | `engine/`, `models/`, `fluidaudio/`, `recordings/` |
| Diagnostic log directory | `kesha.ndjson`, `kesha.<n>.ndjson` and the `diagnostic-logs.json` settings file `kesha logs enable` writes |
| Stats DB | the file and its `-wal` and `-shm` siblings |
| MCP audio directory | `<uuid>.<ext>` files Kesha wrote |
| `KESHA_HOME` | its `cache`, `logs`, `stats.sqlite` and `mcp-audio` children, by the rows above |
| Shared FluidAudio roots | for each subsystem, both its legacy and its in-cache candidate directory (not only the one `fluidSubsystemDirs` resolves, so a partial legacy copy goes too), plus the unread Parakeet copy `unreadFluidCopies` lists. The root and its other entries are `keep`. |
| Engine outside the Model cache (`KESHA_ENGINE_BIN`) | nothing |

## Decisions

- **Plan first, then delete.** The plan is computed and shown before anything is removed, so the question and a refused non-terminal run show the same list.
- **Install lock.** The lock is `<Engine path>.lock` (`src/install-lock.ts:239`), so uninstall locks the Engine path in effect, as install does. It takes it without waiting, and unlike `acquireInstallLock` it fails when the lock cannot be created (`src/install-lock.ts:250` continues unserialised; uninstall must not). A held lock fails with `E_INSTALL_RACE` before any deletion.
- **Partial failure continues.** An entry that cannot be removed is reported as a new CLI-only code, `E_UNINSTALL_PARTIAL`, with the path, the reason and the remedy; the rest are still removed; the exit code is 1. Like `E_INTERRUPTED` it is raised only by the CLI, and the Engine still publishes it in `describe` with `origin: cli` (`rust/src/protocol/describe.rs::CLI_ONLY`), because the capability pact requires every code the CLI raises to be published. The pact fixtures are recorded from the v2.5.0 Engines, so `tests/unit/capabilities-pact.test.ts` lists the code as not yet recorded until the pacts are re-recorded from a release that has it.
- **Removal is plain `rm`.** An entry that holds a `keep` entry (a `KESHA_LOG_DIR` set inside `models/`) is `keep` itself, so nothing removes a file the plan keeps. `engine/` holds the install lock, so it goes last, right after the lock is released. `rm` removes a symbolic link, never what it points to. An emptied state directory goes with a plain `rmdir`; one that does not go stays without a report. Edge cases nobody has hit wait in #1628.
- **No `--plan`.** The question already shows the plan.

## Risks

- Another FluidAudio-based app may share Parakeet in `~/Library/Application Support/FluidAudio/Models`. Removing Kesha's subsystem directories makes that app download it again. Accepted by the maintainer in #1625: only Kesha's directories go, the rest stays.
- A stray `KESHA_HOME` or specific variable can point at a user directory. Only Kesha-named entries are removed and a directory only when empty, so the worst case is a user file that happens to carry a Kesha name, such as `kesha.ndjson`.
- Recovery recordings (`<Model cache>/recordings/`) are the user's own audio from interrupted `kesha record` runs. The maintainer decided they are removed with the rest (#1626); the plan lists them with their size before the question, so they are never removed unseen.
