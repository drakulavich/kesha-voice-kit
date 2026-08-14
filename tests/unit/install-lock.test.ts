import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { acquireInstallLock } from "../../src/install-lock";

const tempDirs: string[] = [];

// The waiters are spawned processes; the FIFO and the umask case need POSIX semantics.
const posixTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function stageBinPath(prefix: string): string {
  const dir = tempDir(prefix);
  mkdirSync(join(dir, "bin"), { recursive: true });
  return join(dir, "bin", "kesha-engine");
}

/** A pid that has certainly exited, so the lock it owns is stale the moment it is planted. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

/** A lock owner as it lands on disk: one `owner-<token>.json` inside the lock directory. */
function writeOwner(lockDir: string, token: string, pid: number): void {
  writeFileSync(
    join(lockDir, `owner-${token}.json`),
    JSON.stringify({ token, pid, host: hostname(), startedAt: Date.now() }),
  );
}

function ownerToken(lockDir: string): string | null {
  const owner = readdirSync(lockDir).find((e) => e.startsWith("owner-"));
  return owner ? owner.slice("owner-".length, -".json".length) : null;
}

interface WaiterOptions {
  maxWaitMs: number;
  holdMs?: number;
  /** Spin until the barrier file appears, so several waiters reach the lock at the same instant. */
  barrier?: boolean;
}

/** One `kesha install` competing for the lock, bracketing its turn in the shared log. */
function spawnWaiter(binPath: string, dir: string, opts: WaiterOptions) {
  const script = join(dir, `waiter-${Math.random().toString(36).slice(2)}.ts`);
  const barrier = opts.barrier
    ? `const spinUntil = Date.now() + 30_000;\n` +
      `while (!existsSync(${JSON.stringify(join(dir, "go"))})) if (Date.now() > spinUntil) process.exit(3);\n`
    : "";
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, writeFileSync } from "fs";\n` +
      `import { acquireInstallLock } from ${JSON.stringify(join(import.meta.dir, "../../src/install-lock.ts"))};\n` +
      `const log = ${JSON.stringify(join(dir, "holders.log"))};\n` +
      `writeFileSync(${JSON.stringify(join(dir, "ready"))} + "-" + process.pid, "");\n` +
      barrier +
      `const release = await acquireInstallLock(${JSON.stringify(binPath)}, ${opts.maxWaitMs});\n` +
      `appendFileSync(log, "enter " + process.pid + "\\n");\n` +
      `await Bun.sleep(${opts.holdMs ?? 0});\n` +
      `appendFileSync(log, "exit " + process.pid + "\\n");\n` +
      `release();\n`,
  );
  return Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
}

/** The greatest number of waiters that were inside the critical section at the same time. */
function maxHolders(logPath: string): number {
  const lines = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
    : [];
  let inside = 0;
  let peak = 0;
  for (const line of lines) {
    inside += line.startsWith("enter") ? 1 : -1;
    peak = Math.max(peak, inside);
  }
  return peak;
}

async function waitForFiles(dir: string, prefix: string, count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (Array.from(new Bun.Glob(`${prefix}-*`).scanSync(dir)).length >= count) return;
    await Bun.sleep(25);
  }
  throw new Error(`only some of the ${count} waiters started`);
}

describe("acquireInstallLock (#997)", () => {
  posixTest("a waiter cannot clear the lock that replaced the dead one it judged", async () => {
    const binPath = stageBinPath("kesha-lock-handover-");
    const dir = tempDir("kesha-lock-handover-run-");
    const lockDir = `${binPath}.lock`;
    mkdirSync(lockDir, { recursive: true });
    // The crashed owner's record is a FIFO, so the waiter blocks inside its staleness check
    // until this test writes it. That turns "two waiters clear the same dead lock at once"
    // from a timing coincidence into something a test can state.
    await Bun.spawn(["mkfifo", join(lockDir, "owner-crashed-owner.json")]).exited;

    const waiter = spawnWaiter(binPath, dir, { maxWaitMs: 1_000 });
    // Opening the write end returns only once the waiter has the read end open.
    const fifo = openSync(join(lockDir, "owner-crashed-owner.json"), "w");

    // The peer's takeover, completed while the waiter is still reading: the dead owner's lock
    // moves aside and a live one stands in its place.
    const aside = `${lockDir}.taken-over`;
    renameSync(lockDir, aside);
    mkdirSync(lockDir);
    writeOwner(lockDir, "live-owner", process.pid);

    writeSync(
      fifo,
      JSON.stringify({
        token: "crashed-owner",
        pid: await deadPid(),
        host: hostname(),
        startedAt: Date.now(),
      }),
    );
    closeSync(fifo);
    const exit = await waiter.exited;

    expect(ownerToken(lockDir)).toBe("live-owner");
    expect(existsSync(join(dir, "holders.log"))).toBe(false);
    expect(exit).not.toBe(0);
  }, 30_000);

  posixTest("waiters that all find a dead owner still take the lock one at a time", async () => {
    const binPath = stageBinPath("kesha-lock-takeover-");
    const dir = tempDir("kesha-lock-takeover-run-");
    mkdirSync(`${binPath}.lock`, { recursive: true });
    writeOwner(`${binPath}.lock`, "crashed-owner", await deadPid());

    const waiters = Array.from({ length: 6 }, () =>
      spawnWaiter(binPath, dir, { maxWaitMs: 30_000, holdMs: 60, barrier: true }),
    );
    await waitForFiles(dir, "ready", waiters.length);
    writeFileSync(join(dir, "go"), "");
    const exits = await Promise.all(waiters.map((w) => w.exited));

    expect(exits).toEqual(waiters.map(() => 0));
    const log = join(dir, "holders.log");
    expect(maxHolders(log)).toBe(1);
    expect(readFileSync(log, "utf8").match(/^enter /gm)).toHaveLength(waiters.length);
    expect(existsSync(`${binPath}.lock`)).toBe(false);
  }, 60_000);

  posixTest("an acquisition that fails partway leaves no lock behind", async () => {
    // A mode-000 directory stands in for the ENOSPC/EIO write failure: everyone but root is
    // locked out of it, so the test asks nothing of the filesystem underneath.
    if (process.getuid?.() === 0) return;
    const binPath = stageBinPath("kesha-lock-unwritable-");
    const previousUmask = process.umask(0o777);
    let release: () => void;
    try {
      release = await acquireInstallLock(binPath, 2_000);
    } finally {
      process.umask(previousUmask);
    }
    release();

    expect(existsSync(`${binPath}.lock`)).toBe(false);
    const second = await acquireInstallLock(binPath, 2_000);
    expect(existsSync(`${binPath}.lock`)).toBe(true);
    second();
  });

  posixTest("waiting on a live owner ends by naming it instead of hanging", async () => {
    const binPath = stageBinPath("kesha-lock-timeout-");
    const release = await acquireInstallLock(binPath, 2_000);
    try {
      await expect(acquireInstallLock(binPath, 200)).rejects.toThrow(
        new RegExp(`held by pid ${process.pid}[\\s\\S]*\\.lock and re-run`),
      );
    } finally {
      release();
    }
  });
});
