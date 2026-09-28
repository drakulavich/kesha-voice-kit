import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLfsPointer, lfsFilterLines, oversized } from "../../.github/scripts/check-file-sizes";
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function blobOf(dir: string, bytes: number): Promise<string> {
  const proc = Bun.spawn(["git", "hash-object", "-w", "--stdin"], { cwd: dir, stdin: Buffer.alloc(bytes), stdout: "pipe" });
  return (await new Response(proc.stdout).text()).trim();
}

async function check(
  tracked: Record<string, number | string>,
  untracked: Record<string, number | string> = {},
  afterAdd: (dir: string) => Promise<void> = async () => {},
) {
  const dir = tempDir("file-sizes-");
  await git(dir, "init", "-q");
  const write = (files: Record<string, number | string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof content === "number" ? Buffer.alloc(content) : content);
    }
  };
  write(tracked);
  await git(dir, "add", "-A");
  write(untracked);
  await afterAdd(dir);
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

  // The Raycast store reads its 2000x1250 listing screenshot (a 2 MiB PNG, no fixture) from raycast/metadata.
  test("the one Raycast store screenshot is exempt, a second file beside it is not", async () => {
    expect((await check({ "raycast/metadata/kesha-voice-kit-1.png": MIB * 2 })).exitCode).toBe(0);

    const { exitCode, stderr } = await check({ "raycast/metadata/kesha-voice-kit-2.png": MIB * 2 });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("raycast/metadata/kesha-voice-kit-2.png");
  });

  test("a staged blob over the limit is reported even after the worktree copy is deleted", async () => {
    const { exitCode, stderr } = await check({ "tests/fixtures/staged.ogg": MIB + 1 }, {}, async (dir) => {
      rmSync(join(dir, "tests/fixtures/staged.ogg"));
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("tests/fixtures/staged.ogg");
    expect(stderr).toContain(`${MIB + 1} bytes`);
  });

  test("a symlink entry is ignored, whatever its target text weighs", async () => {
    const { exitCode, stderr } = await check({}, {}, async (dir) => {
      await git(dir, "update-index", "--add", "--cacheinfo", `120000,${await blobOf(dir, MIB + 1)},link`);
    });

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  });

  test("a gitlink (submodule) entry is ignored", async () => {
    const { exitCode, stderr } = await check({}, {}, async (dir) => {
      await git(dir, "update-index", "--add", "--cacheinfo", "160000,0123456789abcdef0123456789abcdef01234567,sub");
    });

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  });
});

const POINTER = [
  "version https://git-lfs.github.com/spec/v1",
  "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393",
  "size 12345",
  "",
].join("\n");

describe("isLfsPointer", () => {
  test("a pointer's first line is the LFS spec line, with LF or CRLF endings", () => {
    expect(isLfsPointer(Buffer.from(POINTER))).toBe(true);
    expect(isLfsPointer(Buffer.from(POINTER.replaceAll("\n", "\r\n")))).toBe(true);
  });

  test("the spec line anywhere but first, or a near miss, is not a pointer", () => {
    expect(isLfsPointer(Buffer.from(`# notes\n${POINTER}`))).toBe(false);
    expect(isLfsPointer(Buffer.from("version https://git-lfs.github.com/spec/v10\n"))).toBe(false);
    expect(isLfsPointer(Buffer.alloc(0))).toBe(false);
  });
});

describe("lfsFilterLines", () => {
  test("names every attribute line that routes a path through the LFS filter", () => {
    const attributes = "*.wav binary\n*.onnx filter=lfs diff=lfs merge=lfs -text\n  *.bin   filter=lfs\n";
    expect(lfsFilterLines(attributes)).toEqual([2, 3]);
  });

  test("a comment, another filter or a mere mention is not a route", () => {
    expect(lfsFilterLines("# *.onnx filter=lfs\n*.txt filter=crlf\n*.md -filter=lfs\n*.x myfilter=lfs\n")).toEqual([]);
  });
});

describe("check:file-sizes refuses Git LFS", () => {
  test("a tracked LFS pointer fails, however small, naming the file", async () => {
    const { exitCode, stderr } = await check({ "tests/fixtures/model.onnx": POINTER, "README.md": "# hi\n" });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("tests/fixtures/model.onnx");
    expect(stderr).toContain("Git LFS pointer");
    expect(stderr).not.toContain("README.md");
  });

  test("filter=lfs in any tracked .gitattributes fails, naming the file and line", async () => {
    const root = await check({ ".gitattributes": "*.wav binary\n*.onnx filter=lfs diff=lfs merge=lfs -text\n" });
    expect(root.exitCode).toBe(1);
    expect(root.stderr).toContain(".gitattributes:2");

    const nested = await check({ "tests/fixtures/.gitattributes": "*.ogg filter=lfs -text\n" });
    expect(nested.exitCode).toBe(1);
    expect(nested.stderr).toContain("tests/fixtures/.gitattributes:1");
  });

  test("a staged pointer is refused even after the worktree copy is replaced", async () => {
    const { exitCode, stderr } = await check({ "a.bin": POINTER }, {}, async (dir) => {
      writeFileSync(join(dir, "a.bin"), "plain bytes now\n");
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("a.bin");
  });

  test("attributes without the LFS filter and a file quoting the spec line later pass", async () => {
    const { exitCode, stdout, stderr } = await check({
      ".gitattributes": "*.wav binary\n# never filter=lfs\n",
      "docs/lfs.md": `Why we left LFS:\n\n${POINTER}`,
    });

    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});
