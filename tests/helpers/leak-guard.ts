/**
 * Preloaded into every test process (`bunfig.toml`): a spawned stub has to be reaped even when the
 * test that spawned it failed, timed out or was interrupted, and a leak has to be loud rather than
 * found days later in `ps` (#1003). The hooks below are registered once for the process, so the
 * `afterAll` runs after the last file that process loaded rather than once per suite. Temp
 * directories are reaped the same way but quietly (#1175) — the guard owning them is the point, so
 * a suite that leaves one behind is using the helper right.
 */
import { afterAll, afterEach } from "bun:test";
import { installInterruptReaper, reapLeakedProcesses } from "./process";
import { reapTempDirs } from "./temp-dir";

installInterruptReaper();
// An interrupted run reaches no `afterAll`, which is exactly when these directories used to survive (#1175).
process.on("exit", () => reapTempDirs());

function report(scope: string, leaked: string[]): void {
  if (leaked.length === 0) return;
  throw new Error(
    `${scope} left ${leaked.length} process(es) running; the leak guard reaped them:\n  ${leaked.join("\n  ")}`,
  );
}

afterEach(async () => report("this test", await reapLeakedProcesses()));

afterAll(async () => {
  try {
    report("this suite", await reapLeakedProcesses({ sweepDescendants: true }));
  } finally {
    reapTempDirs();
  }
});
