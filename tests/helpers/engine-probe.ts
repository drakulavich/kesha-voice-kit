import { existsSync } from "node:fs";

/**
 * Whether `bin` answers `flag` with a non-empty JSON array.
 *
 * Guards for engine-dependent suites must ask this rather than `existsSync`: the #796 stub
 * was `#!/bin/sh\nexit 0`, which exists and runs and describes nothing, so a presence check
 * un-skips the suite and the empty stdout surfaces as a JSON parse crash instead of a skip
 * (#801). An empty array is treated as no answer for the same reason.
 */
export function enginePublishesJson(bin: string, flag: string): boolean {
  if (!existsSync(bin)) return false;

  let res: ReturnType<typeof Bun.spawnSync>;
  try {
    res = Bun.spawnSync([bin, flag], { stdout: "pipe", stderr: "ignore" });
  } catch {
    return false;
  }
  if (res.exitCode !== 0) return false;

  try {
    const parsed: unknown = JSON.parse(res.stdout.toString());
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}
