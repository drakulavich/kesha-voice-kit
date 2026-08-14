/**
 * Preloaded into every suite (`bunfig.toml`): a spawned stub has to be reaped even when the test
 * that spawned it failed, timed out or was interrupted, and a leak has to be loud rather than
 * found days later in `ps` (#1003).
 */
import { afterAll, afterEach } from "bun:test";
import { installInterruptReaper, reapLeakedProcesses } from "./process";

installInterruptReaper();

function report(scope: string, leaked: string[]): void {
  if (leaked.length === 0) return;
  throw new Error(
    `${scope} left ${leaked.length} process(es) running; the leak guard reaped them:\n  ${leaked.join("\n  ")}`,
  );
}

afterEach(async () => report("this test", await reapLeakedProcesses()));

afterAll(async () => report("this suite", await reapLeakedProcesses({ sweepDescendants: true })));
