import { existsSync, readFileSync, writeFileSync } from "fs";

/**
 * Version-bump gate for the "star the repo" prompt in `kesha install`.
 *
 * Prompts are valuable on first install and on meaningful upgrades (new
 * features) but annoying on patch-only bumps. This module persists the
 * last-seen version to a marker file next to the engine binary and only
 * returns true on a major-or-minor bump.
 */
export function starSeenPath(binPath: string): string {
  return `${binPath}.star-seen`;
}

export function readStarSeen(binPath: string): string | null {
  try {
    const v = readFileSync(starSeenPath(binPath), "utf-8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeStarSeen(binPath: string, version: string): void {
  writeFileSync(starSeenPath(binPath), `${version}\n`);
}

function parseMajorMinor(v: string): [number, number] | null {
  const parts = v.split(".");
  if (parts.length < 2) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return [major, minor];
}

/**
 * Returns true iff `current` is a major-or-minor bump over `seen`.
 * Patch-only bumps return false to avoid nagging on every install.
 */
export function shouldShowStarPrompt(current: string, seen: string | null): boolean {
  if (seen === null) return true;
  const c = parseMajorMinor(current);
  const s = parseMajorMinor(seen);
  if (!c || !s) return false;
  if (c[0] > s[0]) return true;
  if (c[0] === s[0] && c[1] > s[1]) return true;
  return false;
}

export function hasStarMarker(binPath: string): boolean {
  return existsSync(starSeenPath(binPath));
}

/**
 * Prompt the user to star the repo on first install and major/minor bumps.
 * Marker is written before printing so a single run never prompts twice.
 * `shims` injects deterministic `which`/`spawn` for tests — Bun.which()
 * caches PATH at process start, so env-swapping in tests doesn't work.
 */
export async function maybeAskForStar(
  binPath: string,
  currentVersion: string | null,
  log: { info: (msg: string) => void },
  shims?: {
    which?: (name: string) => string | null;
    spawn?: (cmd: string[]) => { exitCode: number | null };
  },
): Promise<void> {
  const which = shims?.which ?? ((n: string) => Bun.which(n));
  const spawn =
    shims?.spawn ??
    ((cmd: string[]) =>
      Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }));
  if (!currentVersion) return;
  const seen = readStarSeen(binPath);
  if (!shouldShowStarPrompt(currentVersion, seen)) {
    return;
  }
  try {
    writeStarSeen(binPath, currentVersion);
  } catch {
    /* Non-fatal — falling through to the prompt is still OK. */
  }

  // Marker recorded — every return below must print, except "already starred".
  const printBasicPrompt = () => {
    log.info("\nIf you enjoy Kesha Voice Kit, consider starring the repo:");
    log.info("  https://github.com/drakulavich/kesha-voice-kit");
  };

  const gh = which("gh");
  if (!gh) {
    printBasicPrompt();
    return;
  }
  const authCheck = spawn([gh, "auth", "status"]);
  if (authCheck.exitCode !== 0) {
    // Unauthenticated — can't check star status; still print so the slot isn't silently consumed.
    printBasicPrompt();
    return;
  }
  const starred = spawn([gh, "api", "user/starred/drakulavich/kesha-voice-kit"]);
  if (starred.exitCode === 0) return; // already starred — slot consumed by verification
  log.info("\n⭐ If you enjoy Kesha Voice Kit, star it on GitHub:");
  log.info("  https://github.com/drakulavich/kesha-voice-kit");
  log.info('  Or run: gh api -X PUT /user/starred/drakulavich/kesha-voice-kit');
}
