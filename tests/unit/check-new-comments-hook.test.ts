import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupGitRepos, git, gitRepoWithRemote } from "../helpers/git-repo";
import { repoPath } from "../helpers/repo";

const HOOK = repoPath(".claude/hooks/check-new-comments.ts");

afterAll(cleanupGitRepos);

async function decision(work: string, filePath: string): Promise<string | null> {
  // The session's cwd is not the project: the hook must find the checkout from the payload and CLAUDE_PROJECT_DIR alone.
  const proc = Bun.spawn(["bun", HOOK], {
    cwd: tmpdir(),
    env: { ...process.env, CLAUDE_PROJECT_DIR: work },
    stdin: new TextEncoder().encode(JSON.stringify({ tool_input: { file_path: filePath } })),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out.trim() ? (JSON.parse(out) as { decision: string }).decision : null;
}

async function trackedFile(work: string, rel: string, content: string): Promise<string> {
  mkdirSync(join(work, "src"), { recursive: true });
  await Bun.write(join(work, rel), content);
  await git(work, "add", rel);
  await git(work, "commit", "-qm", `add ${rel}`);
  return join(work, rel);
}

describe("check-new-comments hook", () => {
  it("blocks a two-line // comment added to a tracked file", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.ts", "export const a = 1;\n");
    await Bun.write(file, "// why this\n// spills over\nexport const a = 1;\n");
    expect(await decision(work, file)).toBe("block");
  });

  it("blocks the same comment when the payload names the file relative to the project", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.ts", "export const a = 1;\n");
    await Bun.write(file, "// why this\n// spills over\nexport const a = 1;\n");
    expect(await decision(work, "src/a.ts")).toBe("block");
  });

  it("blocks a two-line comment in a file Write just created", async () => {
    const work = await gitRepoWithRemote();
    mkdirSync(join(work, "src"), { recursive: true });
    const file = join(work, "src/new.ts");
    await Bun.write(file, "// why this\n// spills over\nexport const n = 1;\n");
    expect(await decision(work, file)).toBe("block");
  });

  it("blocks a /* */ block comment spanning two lines", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.ts", "export const a = 1;\n");
    await Bun.write(file, "/* why this\n   spills over */\nexport const a = 1;\n");
    expect(await decision(work, file)).toBe("block");
  });

  it("allows one-line comments, /** doc contracts and SAFETY blocks", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.ts", "export const a = 1;\n");
    await Bun.write(file, "// one line, why-only\n/** The contract.\n * Two lines are fine here. */\n// SAFETY: the pointer\n// outlives the call\nexport const a = 1;\n");
    expect(await decision(work, file)).toBeNull();
  });

  it("stays silent on a payload without a file", async () => {
    const work = await gitRepoWithRemote();
    expect(await decision(work, "")).toBeNull();
  });
});
