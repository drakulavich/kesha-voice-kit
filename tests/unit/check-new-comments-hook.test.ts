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

  it("blocks a two-line comment the agent has already staged", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.ts", "export const a = 1;\n");
    await Bun.write(file, "// why this\n// spills over\nexport const a = 1;\n");
    await git(work, "add", "src/a.ts");
    expect(await decision(work, file)).toBe("block");
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

  it("blocks a plain line added inside an existing /* */ block, whose delimiters are outside the hunk", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.ts", "/* why this\n   is here */\nexport const a = 1;\n");
    await Bun.write(file, "/* why this\n   and a second thought\n   is here */\nexport const a = 1;\n");
    expect(await decision(work, file)).toBe("block");
  });

  it("does not mistake Rust dereferences or doc-block continuations for comment lines", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.rs", "/** The contract.\n * One line. */\nfn f(a: &mut i32, b: &mut i32) {}\n");
    await Bun.write(file, "/** The contract.\n * One line.\n * A second line of contract. */\nfn f(a: &mut i32, b: &mut i32) {\n    *a = 1;\n    *b = 2;\n}\n");
    expect(await decision(work, file)).toBeNull();
  });

  it("blocks a block comment that opens after code on the same line", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.ts", "export const a = 1;\n");
    await Bun.write(file, "export const a = 1; /* why this\n   spills over */\n");
    expect(await decision(work, file)).toBe("block");
  });

  it("does not let a doc line exempt the ordinary comment lines that follow it", async () => {
    const work = await gitRepoWithRemote();
    const file = await trackedFile(work, "src/a.rs", "fn f() {}\n");
    await Bun.write(file, "/// The contract.\n// why this\n// spills over\nfn f() {}\n");
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
