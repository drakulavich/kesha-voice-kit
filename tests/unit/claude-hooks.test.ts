import { describe, expect, it } from "bun:test";
import { readRepoFile, repoPath } from "../helpers/repo";

type Hook = { type: string; command: string };
type Settings = { hooks?: Record<string, { hooks: Hook[] }[]> };

const settings = JSON.parse(readRepoFile(".claude/settings.json")) as Settings;
const commands = Object.values(settings.hooks ?? {}).flatMap((event) => event.flatMap((e) => e.hooks.map((h) => h.command)));
const hookPaths = commands.map((c) => [...c.matchAll(/\.claude\/hooks\/[\w.-]+/g)].map((m) => m[0]));

describe("hooks .claude/settings.json registers", () => {
  it("registers at least the three project hooks, each command naming exactly one file under .claude/hooks", () => {
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const [i, paths] of hookPaths.entries()) expect(paths, commands[i]).toHaveLength(1);
    // A relative hook path resolves against the session cwd and silently never fires inside a worktree.
    for (const command of commands) expect(command).toStartWith('"$CLAUDE_PROJECT_DIR"/.claude/hooks/');
  });

  // #1179: a hook that lives only in one checkout is documentation everywhere else, and so is a local chmod +x.
  it("names files that git tracks as executable, so every fresh clone runs the same gate", () => {
    const index = Bun.spawnSync(["git", "ls-files", "-s", "--", ".claude/hooks"], { cwd: repoPath(".") }).stdout.toString();
    const modes = new Map([...index.matchAll(/^(\d{6}) \S+ \d\t(.+)$/gm)].map((m) => [m[2]!, m[1]!]));
    for (const hook of hookPaths.flat()) expect(modes.get(hook), hook).toBe("100755");
  });
});
