import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  pidIsAlive,
  reapLeakedProcesses,
  stubbornShell,
  trackPid,
  waitForPidExit,
} from "../helpers/process";
import { readRepoFile, repoPath } from "../helpers/repo";

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

  /** #1131: an interrupted run reaches no hook at all, so the fixture has to end itself. */
  posix("expires on its own clock when no reaper ever signals it", async () => {
    const pid = spawnStubborn("kesha-engine-leak-guard-fixture", 2);

    expect(await waitForPidExit(pid)).toBe(true);
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
