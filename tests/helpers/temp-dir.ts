import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      const dir = mkdtempSync(join(tmpdir(), prefix));
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
          // One directory the OS refuses to release must not replace the louder process report (#1175).
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
