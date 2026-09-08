import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const trackedDirs = new Set<string>();

/** A temp directory the preloaded guard removes when the suite ends; removing it by hand too is safe (#1175). */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedDirs.add(dir);
  return dir;
}

/** Removes every directory `tempDir()` handed out and returns them; one already gone is not an error. */
export function reapTempDirs(): string[] {
  const reaped = [...trackedDirs];
  trackedDirs.clear();
  for (const dir of reaped) rmSync(dir, { recursive: true, force: true });
  return reaped;
}
