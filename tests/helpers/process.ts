import { existsSync, readFileSync } from "fs";

const PID_FILE_POLL_INTERVAL_MS = 25;
// 10s: the fake engine traps SIGTERM, so every abort waits out FORCE_KILL_GRACE_MS before SIGKILL.
const PID_FILE_POLL_ATTEMPTS = 400;
const PID_EXIT_POLL_ATTEMPTS = 400;
const REAP_GRACE_MS = 500;

export async function waitForPidFile(
  path: string,
  attempts: number = PID_FILE_POLL_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    if (existsSync(path)) return trackPid(Number(readFileSync(path, "utf8")));
    await Bun.sleep(PID_FILE_POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for pid file: ${path}`);
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidExit(pid: number): Promise<boolean> {
  for (let i = 0; i < PID_EXIT_POLL_ATTEMPTS; i++) {
    if (!pidIsAlive(pid)) return true;
    await Bun.sleep(PID_FILE_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * A stub that announces itself by pid file is a grandchild the harness never holds a handle to,
 * so when the test fails before killing it nothing else can. Tracking it here is what lets the
 * leak guard reap it (#1003).
 */
const trackedPids = new Set<number>();

/** A pid the OS recycled belongs to a stranger, so only a command still shaped like one of this
 *  suite's fixtures may be signalled. */
const FIXTURE_COMMAND = /kesha|cli-entry\.ts/;

export function trackPid(pid: number): number {
  if (Number.isInteger(pid) && pid > 0) trackedPids.add(pid);
  return pid;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

function processTable(): ProcessRow[] {
  if (process.platform === "win32") return [];
  const format = "pid=,ppid=,command=";
  const res = Bun.spawnSync(["ps", "-eo", format], { stdout: "pipe", stderr: "ignore" });
  if (!res.success) return [];
  return res.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
      if (!match || match[3]!.includes(format)) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }];
    });
}

function descendantsOf(table: ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const found: ProcessRow[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()!) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

function survivors(sweepDescendants: boolean): ProcessRow[] {
  const live = new Set([...trackedPids].filter(pidIsAlive));
  for (const pid of [...trackedPids]) if (!live.has(pid)) trackedPids.delete(pid);
  if (!sweepDescendants && live.size === 0) return [];

  const table = processTable();
  const found = new Map<number, ProcessRow>();
  // Descendants only: another lane's strays are never ours to kill.
  if (sweepDescendants) for (const row of descendantsOf(table, process.pid)) found.set(row.pid, row);
  for (const row of table) {
    if (live.has(row.pid) && FIXTURE_COMMAND.test(row.command)) found.set(row.pid, row);
  }
  return [...found.values()];
}

function safeKill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone between the sweep listing it and the signal reaching the kernel.
  }
}

async function waitForAllExit(rows: ProcessRow[]): Promise<void> {
  const deadline = Date.now() + REAP_GRACE_MS;
  while (Date.now() < deadline && rows.some((row) => pidIsAlive(row.pid))) {
    await Bun.sleep(PID_FILE_POLL_INTERVAL_MS);
  }
}

/**
 * Kills everything the suite left running and names it. `sweepDescendants` also collects children
 * no test ever saw a pid for — an engine spawned in-process announces nothing — and costs one `ps`,
 * so the per-test pass leaves it off and the per-file pass turns it on.
 */
export async function reapLeakedProcesses(
  opts: { sweepDescendants?: boolean } = {},
): Promise<string[]> {
  const leaked = survivors(opts.sweepDescendants === true);
  if (leaked.length === 0) return [];

  for (const row of leaked) safeKill(row.pid, "SIGTERM");
  await waitForAllExit(leaked);
  // Some fixtures trap SIGTERM on purpose, which is exactly the shape that outlives a suite.
  for (const row of leaked) if (pidIsAlive(row.pid)) safeKill(row.pid, "SIGKILL");
  await waitForAllExit(leaked);

  for (const row of leaked) trackedPids.delete(row.pid);
  return leaked.map(
    (row) => `pid ${row.pid}${pidIsAlive(row.pid) ? " (survived SIGKILL)" : ""}: ${row.command}`,
  );
}

let interruptReaperInstalled = false;

/** An interrupted run reaches no hook at all, which is how the #1003 strays outlived the suite by
 *  days; a synchronous SIGKILL on the way out is the only reaping left. */
export function installInterruptReaper(): void {
  if (interruptReaperInstalled) return;
  interruptReaperInstalled = true;
  const reap = () => {
    for (const row of survivors(true)) safeKill(row.pid, "SIGKILL");
  };
  process.on("exit", reap);
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      reap();
      process.exit(exitCode);
    });
  }
}
