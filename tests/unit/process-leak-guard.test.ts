import { describe, expect, test } from "bun:test";
import { pidIsAlive, reapLeakedProcesses, trackPid, waitForPidExit } from "../helpers/process";

const posix = process.platform === "win32" ? test.skip : test;

/** `label` lands in argv as `$0`, which is what makes the fixture recognisable in `ps`. */
function spawnStubborn(label: string): number {
  const proc = Bun.spawn(["sh", "-c", "trap '' TERM INT; while :; do sleep 1; done", label], {
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
});
