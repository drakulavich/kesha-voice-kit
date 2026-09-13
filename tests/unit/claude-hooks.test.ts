import { describe, expect, it } from "bun:test";
import { accessSync, constants } from "node:fs";
import { readRepoFile, repoPath } from "../helpers/repo";

type Hook = { type: string; command: string };
type Settings = { hooks?: Record<string, { hooks: Hook[] }[]> };

const settings = JSON.parse(readRepoFile(".claude/settings.json")) as Settings;
const commands = Object.values(settings.hooks ?? {}).flatMap((event) => event.flatMap((e) => e.hooks.map((h) => h.command)));
const hookPaths = commands.flatMap((c) => [...c.matchAll(/\.claude\/hooks\/[\w.-]+/g)].map((m) => m[0]));

describe("hooks .claude/settings.json registers", () => {
  it("registers at least the three project hooks", () => {
    expect(hookPaths.length).toBeGreaterThanOrEqual(3);
  });

  // #1179: a hook that lives only in one checkout is documentation everywhere else.
  it("names files that are tracked and executable, so every contributor runs the same gate", () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "--", ".claude/hooks"], { cwd: repoPath(".") }).stdout.toString().split("\n");
    for (const hook of hookPaths) {
      expect(tracked).toContain(hook);
      expect(() => accessSync(repoPath(hook), constants.X_OK)).not.toThrow();
    }
  });
});
