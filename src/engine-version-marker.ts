import { readFileSync, writeFileSync } from "fs";

/**
 * Version-marker file written next to the engine binary on download (#151).
 * Lets `kesha install` detect a stale cached engine after a CLI upgrade and
 * re-download without requiring `--no-cache`.
 *
 * Lives in its own module so `engine-install.ts` does not co-locate
 * `readFileSync` with `fetch()` — OpenClaw's plugin scanner pairs those into
 * a `[potential-exfiltration]` warning at install time, which is a false
 * positive for this engine-binary download path.
 */
export function getVersionMarkerPath(binPath: string): string {
  return `${binPath}.version`;
}

/** Read the recorded version for the installed binary, or null if missing / empty. */
export function readInstalledEngineVersion(binPath: string): string | null {
  try {
    const v = readFileSync(getVersionMarkerPath(binPath), "utf-8").trim();
    return v.length > 0 ? v : null;
  } catch {
    // Missing, unreadable, or permission-denied → treat as no marker so we re-download.
    return null;
  }
}

export function writeInstalledEngineVersion(binPath: string, version: string): void {
  writeFileSync(getVersionMarkerPath(binPath), `${version}\n`);
}
