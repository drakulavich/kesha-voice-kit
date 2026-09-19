import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oversized } from "../../.github/scripts/check-file-sizes";
import { REPO_ROOT } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const SCRIPT = `${REPO_ROOT}/.github/scripts/check-file-sizes.ts`;
const MIB = 1_048_576;
const SENTENCE = "large fixtures ship as a release asset with a SHA-256 pin, never in git or LFS";

describe("oversized", () => {
  test("exactly the limit is reported, one byte under is not", () => {
    expect(oversized([{ path: "a.bin", bytes: MIB }], MIB)).toEqual([{ path: "a.bin", bytes: MIB }]);
    expect(oversized([{ path: "a.bin", bytes: MIB - 1 }], MIB)).toEqual([]);
  });

  test("largest first, ties broken by path", () => {
    const entries = [
      { path: "z.bin", bytes: MIB },
      { path: "small.bin", bytes: 10 },
      { path: "big.bin", bytes: MIB * 3 },
      { path: "a.bin", bytes: MIB },
    ];
    expect(oversized(entries, MIB)).toEqual([
      { path: "big.bin", bytes: MIB * 3 },
      { path: "a.bin", bytes: MIB },
      { path: "z.bin", bytes: MIB },
    ]);
  });

  test("nothing tracked means nothing oversized", () => {
    expect(oversized([], MIB)).toEqual([]);
  });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function check(tracked: Record<string, number>, untracked: Record<string, number> = {}) {
  const dir = tempDir("file-sizes-");
  await git(dir, "init", "-q");
  const write = (files: Record<string, number>) => {
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), Buffer.alloc(bytes));
    }
  };
  write(tracked);
  await git(dir, "add", "-A");
  write(untracked);
  const proc = Bun.spawn(["bun", SCRIPT], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("check:file-sizes against a repository", () => {
  test("a tracked file one byte over 1 MiB fails, naming the file and where it belongs", async () => {
    const { exitCode, stderr } = await check({
      "tests/fixtures/huge.ogg": MIB + 1,
      "README.md": 42,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("tests/fixtures/huge.ogg");
    expect(stderr).toContain(`${MIB + 1} bytes`);
    expect(stderr).toContain(SENTENCE);
    expect(stderr).not.toContain("README.md");
  });

  test("a repository whose tracked files stay under the limit passes, whatever is untracked", async () => {
    const { exitCode, stdout, stderr } = await check(
      { "tests/fixtures/edge.wav": MIB - 1, "docs/logo.png": 600_000 },
      { "scratch.bin": MIB * 2 },
    );

    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  // The Raycast store reads its 2000x1250 listing screenshots (2 MiB PNGs, no fixture) from raycast/metadata.
  test("a Raycast store screenshot is exempt, the same bytes anywhere else are not", async () => {
    expect((await check({ "raycast/metadata/kesha-voice-kit-2.png": MIB * 2 })).exitCode).toBe(0);

    const { exitCode, stderr } = await check({ "raycast/assets/kesha-voice-kit-2.png": MIB * 2 });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("raycast/assets/kesha-voice-kit-2.png");
  });
});
