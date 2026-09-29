import { expect, test } from "bun:test";

test("offline.sh refuses to run without a command, before probing the network", () => {
  const run = Bun.spawnSync(["bash", ".github/scripts/offline.sh"], { env: { ...process.env, PATH: "/usr/bin:/bin" } });
  expect(run.exitCode).toBe(2);
  expect(run.stderr.toString()).toContain("usage: offline.sh <command");
  expect(run.stderr.toString()).not.toContain("github.com");
});
