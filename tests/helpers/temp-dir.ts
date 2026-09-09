import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the helper creates lives under here, so the sweep below cannot reach a directory it did not create (#1175). */
function testsRoot(): string {
  const root = join(tmpdir(), "kesha-tests");
  mkdirSync(root, { recursive: true });
  return root;
}

export interface TempDirRegistry {
  /** Creates a temp directory this registry will remove; removing it by hand too is safe (#1175). */
  tempDir(prefix: string): string;
  /** Removes every directory this registry handed out and returns the ones that are gone. */
  reapTempDirs(): string[];
}

/** A registry of its own, so a test can reap without touching directories another file still holds. */
export function createTempDirRegistry(): TempDirRegistry {
  const trackedDirs = new Set<string>();
  return {
    tempDir(prefix: string): string {
      const dir = mkdtempSync(join(testsRoot(), prefix));
      trackedDirs.add(dir);
      return dir;
    },
    reapTempDirs(): string[] {
      const tracked = [...trackedDirs];
      trackedDirs.clear();
      const removed: string[] = [];
      for (const dir of tracked) {
        try {
          rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        } catch (err) {
          // Kept for the exit pass to retry: a refusal is often a handle closing a moment later (#1175).
          trackedDirs.add(dir);
          console.error(`leak guard could not remove ${dir}: ${err}`);
        }
      }
      return removed;
    },
  };
}

const shared = createTempDirRegistry();

/** A temp directory the preloaded guard removes when the test process ends; removing it by hand too is safe (#1175). */
export const tempDir = shared.tempDir;

/** Removes every directory `tempDir()` handed out and returns the ones that are gone; one already gone is not an error. */
export const reapTempDirs = shared.reapTempDirs;

/** Longer than any run can live: 5x the longest CI job timeout (45 min), so a concurrent run's directories are never stale (#1175). */
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

/** Removes directories left by a run no handler survived — SIGKILL, or a Windows exit that could not release a handle — and returns the ones that are gone (#1175). */
export function sweepStaleTempDirs(root: string = testsRoot(), now: number = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const cutoff = now - STALE_AFTER_MS;
  const removed: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (statSync(dir).mtimeMs > cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Another run may be removing the same directory; what survives is swept next time.
    }
  }
  return removed;
}
