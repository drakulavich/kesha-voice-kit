import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { hostname } from "os";
import { dirname, join } from "path";
import { errorMessage } from "./error-utils";
import { log } from "./log";

/**
 * How long a lock may sit before a waiter takes it over without proof its owner died.
 *
 * A crashed or Ctrl-C'd install is detected immediately by pid liveness, so this ceiling only
 * governs an owner we cannot probe — another host or container sharing the cache directory.
 * It has to clear the slowest legitimate install (a cold 2.4 GB model bundle on a thin link
 * runs past an hour), and still let a wedged cache heal itself the same day.
 */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;
const POLL_START_MS = 100;
const POLL_MAX_MS = 2_000;

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  startedAt: number;
}

function ownerPath(lockDir: string): string {
  return join(lockDir, "owner.json");
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(ownerPath(lockDir), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockDir: string): boolean {
  const owner = readOwner(lockDir);
  if (owner && owner.host === hostname() && !pidAlive(owner.pid)) return true;
  let startedAt = owner?.startedAt;
  if (startedAt === undefined) {
    try {
      startedAt = statSync(lockDir).mtimeMs;
    } catch {
      return false;
    }
  }
  return Date.now() - startedAt > STALE_LOCK_MS;
}

function releaseIfOwned(lockDir: string, token: string): void {
  // A stale-lock takeover may have handed the directory to someone else while we ran.
  if (readOwner(lockDir)?.token !== token) return;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch (e) {
    log.warn(
      `Could not remove the install lock at ${lockDir} (${errorMessage(e)}); ` +
        "delete it if a later `kesha install` reports waiting for an install that is not running.",
    );
  }
}

/**
 * Serialises `kesha install` runs sharing one engine directory (#997).
 *
 * `mkdir` is the atomic primitive on POSIX and Windows alike. A lock we cannot create or
 * clear (read-only Nix store, foreign permissions) degrades to running unserialised rather
 * than failing an install that would otherwise work — the post-install version check is what
 * keeps the outcome honest either way.
 */
export async function acquireInstallLock(binPath: string): Promise<() => void> {
  const lockDir = `${binPath}.lock`;
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
  };
  let delay = POLL_START_MS;
  let announced = false;

  for (;;) {
    try {
      mkdirSync(dirname(binPath), { recursive: true });
      mkdirSync(lockDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        log.debug(`no install lock at ${lockDir} (${errorMessage(e)}); continuing unserialised.`);
        return () => {};
      }
      if (lockIsStale(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch (err) {
          log.debug(`stale install lock ${lockDir} not removable (${errorMessage(err)}).`);
          return () => {};
        }
        continue;
      }
      if (!announced) {
        announced = true;
        const other = readOwner(lockDir);
        log.warn(
          `Another \`kesha install\`${other ? ` (pid ${other.pid})` : ""} is using ` +
            `${dirname(binPath)}; waiting for it to finish...`,
        );
      }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, POLL_MAX_MS);
      continue;
    }
    writeFileSync(ownerPath(lockDir), JSON.stringify(owner));
    return () => releaseIfOwned(lockDir, owner.token);
  }
}
