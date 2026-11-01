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
  reason?: string;     // for "keep": "not created by Kesha", "recovery recordings", "KESHA_ENGINE_BIN outside the Model cache"
}
```

Volume, measured on the maintainer's Mac: 4 roots, about 470 files, 5.7 GB. A plan has one entry per known location (about 12), not one per file, plus one `keep` entry per foreign top-level entry found. Sizing walks the same trees `status --disk` walks, which takes 0.52 s wall time there (`time bun bin/kesha.js status --disk`).

Ownership is decided per known location, never per file:

| Location | Owned by Kesha |
|---|---|
| Model cache | its known children: `engine/`, `models/`, `fluidaudio/`, and the install lock directory. Any other top-level entry is `keep`. `recordings/` is `keep` (see Open Questions). |
| Diagnostic log directory, MCP audio directory | the whole directory |
| Stats DB file | the file and its SQLite `-wal`/`-shm` siblings |
| `KESHA_HOME` | only its four children above; the directory itself is removed only if it is then empty |
| Shared FluidAudio roots | only the subsystem directories `fluidSubsystemDirs` lists outside the cache, plus the unread Parakeet copy `unreadFluidCopies` lists. The root and its other entries are `keep`. |

## Decisions

- **Plan first, then delete.** The plan is computed and shown before anything is removed, so the question and a refused non-terminal run show the same list.
- **Install lock.** `acquireInstallLock` with no wait. A held lock fails before any deletion; uninstall never waits the 6 h an install may wait.
- **Partial failure continues.** A path that cannot be removed is reported with a coded error naming it; the remaining entries are still removed; the exit code is 1.
- **No `--plan`.** The question already shows the plan.

## Risks

- Another FluidAudio-based app may share Parakeet in `~/Library/Application Support/FluidAudio/Models`. Removing Kesha's subsystem directories makes that app download it again. Accepted by the maintainer in #1625: only Kesha's directories go, the rest stays.
- A path resolved from a stray `KESHA_HOME` could point at a user directory. Only known children are removed and the root only when empty, so the worst case is removing a `cache/` or `logs/` the user made by hand under that name.

## Open Questions

- Recovery recordings (`<Model cache>/recordings/`) hold the user's own audio from interrupted `kesha record` runs. This design keeps and lists them. Confirm, or decide they are removed with the rest.
