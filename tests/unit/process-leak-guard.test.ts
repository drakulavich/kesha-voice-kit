import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pidIsAlive,
  reapLeakedProcesses,
  stubbornShell,
  trackPid,
  waitForPidExit,
  waitForPidFile,
} from "../helpers/process";
import { readRepoFile, repoPath } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const posix = process.platform === "win32" ? test.skip : test;

/** `label` lands in argv as `$0`, which is what makes the fixture recognisable in `ps`. */
function spawnStubborn(label: string, ttlSeconds?: number): number {
  const proc = Bun.spawn(["sh", "-c", stubbornShell("TERM INT", ttlSeconds), label], {
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
  return proc.pid;
}

function spawnStranger(): number {
  const proc = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  proc.unref();
  return proc.pid;
}

/**
 * A child that exits only once its parent has become `sleep`, which never reaps: exiting earlier lets
 * the shell reap it first, and the pid is then simply gone (seen on CI as `Received: ""`). Bounded
 * (~30 s) and ends early when its parent is gone, so an interrupted run leaves no orphan behind.
 * `$$` is left for the parent's double quotes to expand, so the child holds the parent's own pid;
 * `$PPID` would re-point at an adopter once the parent exits. Every other `$` is the child's.
 * Its output goes nowhere, so it never holds the parent's captured stdout open.
 */
const WAIT_FOR_SLEEPING_PARENT =
  'sh -c "i=0; until ps -o comm= -p $$ | grep -q \'sleep$\'; do ' +
  'kill -0 $$ 2>/dev/null || exit 0; i=\\$((i + 1)); [ \\$i -lt 600 ] || exit 0; sleep 0.05; done" >/dev/null 2>&1';

describe("process leak guard", () => {
  posix("reaps a tracked stub the test never killed, and names it", async () => {
    const pid = trackPid(spawnStubborn("kesha-engine-leak-guard-fixture"));

    const leaked = await reapLeakedProcesses();

    expect(leaked).toHaveLength(1);
    expect(leaked[0]).toContain(String(pid));
    expect(await waitForPidExit(pid)).toBe(true);
  });

  /** The fixture traps SIGTERM on purpose, so only the SIGKILL escalation can end it. */
  posix("escalates to SIGKILL rather than reporting a stub it failed to kill", async () => {
    const pid = trackPid(spawnStubborn("kesha-engine-leak-guard-fixture"));

    const leaked = await reapLeakedProcesses();

    expect(leaked[0]).not.toContain("survived SIGKILL");
    expect(pidIsAlive(pid)).toBe(false);
  });

  /** A pid the OS recycled onto a stranger must not be signalled just because a test held it. */
  posix("leaves a tracked pid alone once its command is no longer a fixture", async () => {
    const pid = trackPid(spawnStranger());

    const leaked = await reapLeakedProcesses();

    expect(leaked).toEqual([]);
    expect(pidIsAlive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
    expect(await waitForPidExit(pid)).toBe(true);
  });

  /** An in-process spawn publishes no pid file, so only the descendant sweep can find it. */
  posix("sweeps an untracked descendant the suite left running", async () => {
    const pid = spawnStubborn("kesha-engine-leak-guard-fixture");

    const leaked = await reapLeakedProcesses({ sweepDescendants: true });

    expect(leaked.some((entry) => entry.includes(String(pid)))).toBe(true);
    expect(await waitForPidExit(pid)).toBe(true);
  });

  /** #1160: `kill(pid, 0)` succeeds on an exited child its parent has not reaped yet. */
  posix("counts an exited but unreaped child as gone", async () => {
    const parent = Bun.spawn(["sh", "-c", `${WAIT_FOR_SLEEPING_PARENT} & echo $!; exec sleep 30`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const zombie = Number(new TextDecoder().decode((await parent.stdout.getReader().read()).value));
      const stat = () => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(zombie)]).stdout.toString();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !stat().startsWith("Z")) await Bun.sleep(20);
      expect(stat()).toStartWith("Z");

      expect(pidIsAlive(zombie)).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      await parent.exited;
    }
  }, 20_000);

  posix("the zombie fixture's child ends on its own when its parent never becomes sleep", async () => {
    const parent = Bun.spawnSync(["sh", "-c", `${WAIT_FOR_SLEEPING_PARENT} & echo $!`]);
    const child = Number(parent.stdout.toString());

    expect(await waitForPidExit(child)).toBe(true);
  });

  /** #1131: an interrupted run reaches no hook at all, so the fixture has to end itself. */
  posix("expires on its own clock when no reaper ever signals it", async () => {
    const pid = spawnStubborn("kesha-engine-leak-guard-fixture", 2);

    expect(await waitForPidExit(pid)).toBe(true);
  });
});

describe("pid files", () => {
  /** #1274: `Bun.write` creates the file before it writes the pid, and read in between, `Number("")` was pid 0, which `kill(0, 0)` always finds alive. */
  test("a pid file read before its pid lands waits for the pid", async () => {
    const path = join(tempDir("kesha-pid-file-"), "engine.pid");
    writeFileSync(path, "");
    setTimeout(() => writeFileSync(path, String(process.pid)), 200);

    expect(await waitForPidFile(path)).toBe(process.pid);
  });
});

const SCAN_ROOTS = [
  { dir: "tests", ext: ".ts" },
  { dir: "rust/src", ext: ".rs" },
];

const IMMORTAL_FIXTURE = /trap ''.*while\s+(?::|true)/;

function immortalFixtures(): string[] {
  return SCAN_ROOTS.flatMap(({ dir, ext }) =>
    readdirSync(repoPath(dir), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(ext))
      .sort()
      .flatMap((name) =>
        readRepoFile(`${dir}/${name}`)
          .split("\n")
          .flatMap((line, i) => (IMMORTAL_FIXTURE.test(line) ? [`${dir}/${name}:${i + 1}`] : [])),
      ),
  );
}

/** The shape #1131 forbids, rebuilt from its replacement so this file is not its own offender. */
const UNBOUNDED = stubbornShell("TERM INT", 1).replace(/n=0;.*/, "while :; do sleep 1; done");

describe("signal-immune fixtures", () => {
  test("are told apart from bounded ones, or the scan below passes by seeing nothing", () => {
    expect(IMMORTAL_FIXTURE.test(UNBOUNDED)).toBe(true);
    expect(IMMORTAL_FIXTURE.test(stubbornShell("TERM INT", 1))).toBe(false);
  });

  test("all carry a clock, so an interrupted run cannot strand one at PPID=1", () => {
    const offenders = immortalFixtures();
    if (offenders.length === 0) return;

    throw new Error(
      `these fixtures block a signal and then loop forever, so a run killed mid-test leaves them ` +
        `at PPID=1 until someone finds them in \`ps\` (#1131):\n  ${offenders.join("\n  ")}\n` +
        `Build the command with stubbornShell() from tests/helpers/process.ts, or bound the loop by ` +
        `hand where that helper cannot reach. Convention: tests/integration/README.md.`,
    );
  });
});
