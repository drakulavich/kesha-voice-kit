import { randomUUID } from "crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { hostname } from "os";
import { dirname, join } from "path";
import { TS_NATIVE_CODES } from "./error-codes";
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
/**
 * A waiter that has outlasted the stale ceiling is looking at a cache held by a chain of
 * installs, or by an owner it can neither probe nor outlive. Naming the holder beats hanging.
 */
const MAX_WAIT_MS = STALE_LOCK_MS;
const POLL_START_MS = 100;
const POLL_MAX_MS = 2_000;
const OWNER_PREFIX = "owner-";
const OWNER_SUFFIX = ".json";

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  startedAt: number;
}

/**
 * The owner is named by its file rather than identified by a field inside one: unlinking that
 * exact name is what makes both release and stale-lock takeover exclusive. Of two waiters
 * clearing the same dead owner one wins the unlink and the other gets ENOENT, and neither can
 * remove an owner it did not judge — the lock a peer published in between has another name.
 */
function ownerPath(lockDir: string, token: string): string {
  return join(lockDir, `${OWNER_PREFIX}${token}${OWNER_SUFFIX}`);
}

function readOwner(lockDir: string): LockOwner | null {
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch {
    return null;
  }
  const name = entries.find((e) => e.startsWith(OWNER_PREFIX) && e.endsWith(OWNER_SUFFIX));
  if (!name) return null;
  try {
    return JSON.parse(readFileSync(join(lockDir, name), "utf8")) as LockOwner;
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

function lockIsStale(owner: LockOwner): boolean {
  if (owner.host === hostname() && !pidAlive(owner.pid)) return true;
  return Date.now() - owner.startedAt > STALE_LOCK_MS;
}

/**
 * Frees the lock: `staleToken` names the owner to unlink, or null for a directory holding no
 * owner at all, which is never a held lock — only the instant between an owner unlinking its
 * file and the empty directory going away, or a leftover from some other writer.
 */
function clearLock(lockDir: string, staleToken: string | null): boolean {
  if (staleToken !== null) {
    try {
      unlinkSync(ownerPath(lockDir, staleToken));
    } catch (e) {
      log.debug(`stale install lock ${lockDir} was cleared by another waiter (${errorMessage(e)}).`);
      return false;
    }
  }
  try {
    rmdirSync(lockDir);
  } catch (e) {
    // Only an empty directory goes; a waiter that published its own lock here keeps it.
    if (staleToken === null) {
      log.debug(`install lock ${lockDir} is not empty (${errorMessage(e)}).`);
      return false;
    }
  }
  return true;
}

function releaseIfOwned(lockDir: string, token: string): void {
  try {
    unlinkSync(ownerPath(lockDir, token));
  } catch (e) {
    // Our lock was taken over while we ran, so there is nothing of ours left to remove.
    log.debug(`install lock ${lockDir} was no longer ours to release (${errorMessage(e)}).`);
    return;
  }
  try {
    rmdirSync(lockDir);
  } catch {
    if (readOwner(lockDir)) return;
    log.warn(
      `Could not remove the install lock at ${lockDir}, so the next \`kesha install\` will wait ` +
        "for it; delete it if no install is running.",
    );
  }
}

function discard(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    try {
      // A directory we cannot read defeats the recursive walk but not a plain rmdir.
      rmdirSync(dir);
    } catch {
      log.debug(`could not remove ${dir} (${errorMessage(e)}).`);
    }
  }
}

type PublishOutcome = "acquired" | "held" | "impossible";

/**
 * Publishes a complete lock in one step: the directory is built with its owner file already
 * inside and renamed into place, so a failure mid-acquisition (ENOSPC, EIO) cannot leave an
 * ownerless lock behind. `rename` replaces an empty directory and refuses a directory holding
 * an owner, which is the exclusion itself.
 */
function publishLock(lockDir: string, owner: LockOwner): PublishOutcome {
  const staging = `${lockDir}.staging-${owner.token}`;
  try {
    mkdirSync(staging, { recursive: true });
    writeFileSync(ownerPath(staging, owner.token), JSON.stringify(owner));
  } catch (e) {
    discard(staging);
    log.debug(`no install lock at ${lockDir} (${errorMessage(e)}); continuing unserialised.`);
    return "impossible";
  }
  try {
    renameSync(staging, lockDir);
    return "acquired";
  } catch (e) {
    discard(staging);
    // Windows reports a directory in the way as EPERM/EEXIST, POSIX as ENOTEMPTY.
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (["ENOTEMPTY", "EEXIST", "EPERM", "EACCES", "ENOTDIR"].includes(code)) return "held";
    log.debug(`no install lock at ${lockDir} (${errorMessage(e)}); continuing unserialised.`);
    return "impossible";
  }
}

/**
 * The wait ceiling in seconds, for a job that would rather fail than sit behind a holder it
 * cannot outlast (and what makes the timeout reachable in a test).
 */
function configuredMaxWaitMs(): number {
  const raw = process.env.KESHA_INSTALL_LOCK_WAIT_SECS?.trim();
  if (!raw) return MAX_WAIT_MS;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) {
    throw new Error(
      `error [${TS_NATIVE_CODES.INVALID_ARG}]: KESHA_INSTALL_LOCK_WAIT_SECS="${raw}" is not a ` +
        "positive number of seconds.\n  Fix: set it to how many seconds `kesha install` may wait " +
        "for another install to release the cache, or unset it for the default (6 h).",
    );
  }
  return secs * 1_000;
}

/**
 * Giving up on the lock is `E_INSTALL_RACE` for the same reason an overwritten cache is: another
 * install reached this cache first, nothing was written, and re-running once it is quiet is the
 * fix — so a consumer retrying on that code does the right thing here too (#1018).
 */
function waitTimedOut(binPath: string, holder: LockOwner | null, waitedMs: number): Error {
  const waited =
    waitedMs >= 60_000 ? `${Math.round(waitedMs / 60_000)} min` : `${Math.round(waitedMs / 1_000)}s`;
  const who = holder ? `pid ${holder.pid} on ${holder.host}` : "an install it cannot identify";
  return new Error(
    `error [${TS_NATIVE_CODES.INSTALL_RACE}]: ` +
      `Gave up after ${waited} waiting for another \`kesha install\` to release ` +
      `${dirname(binPath)}: it is held by ${who}.\n` +
      `  Fix: wait for that install to finish, or — if none is running — delete ` +
      `${binPath}.lock and re-run. Concurrent jobs want private caches ` +
      "(`KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN`).",
  );
}

/**
 * Serialises `kesha install` runs sharing one engine directory (#997).
 *
 * A lock we cannot create or clear (read-only Nix store, foreign permissions) degrades to
 * running unserialised rather than failing an install that would otherwise work — the
 * post-install version check is what keeps the outcome honest either way.
 */
export async function acquireInstallLock(
  binPath: string,
  maxWaitMs = configuredMaxWaitMs(),
): Promise<() => void> {
  const lockDir = `${binPath}.lock`;
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
  };
  const deadline = Date.now() + maxWaitMs;
  let delay = POLL_START_MS;
  let announced = false;

  try {
    mkdirSync(dirname(binPath), { recursive: true });
  } catch (e) {
    log.debug(`no install lock at ${lockDir} (${errorMessage(e)}); continuing unserialised.`);
    return () => {};
  }

  for (;;) {
    const outcome = publishLock(lockDir, owner);
    if (outcome === "acquired") return () => releaseIfOwned(lockDir, owner.token);
    if (outcome === "impossible") return () => {};

    const holder = readOwner(lockDir);
    if ((holder === null || lockIsStale(holder)) && clearLock(lockDir, holder?.token ?? null)) {
      continue;
    }

    if (!announced) {
      announced = true;
      log.warn(
        `Another \`kesha install\`${holder ? ` (pid ${holder.pid})` : ""} is using ` +
          `${dirname(binPath)}; waiting for it to finish...`,
      );
    }
    if (Date.now() + delay >= deadline) throw waitTimedOut(binPath, holder, maxWaitMs);
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}
