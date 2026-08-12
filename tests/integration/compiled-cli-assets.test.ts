import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepoFile, repoPath } from "../helpers/repo";

// The .deb/.rpm payload is `bun build --compile`d from bin/kesha.js and packaged as that
// single file, so any asset resolved at runtime instead of embedded is missing there (#914).
let workDir: string;
let compiledBin: string;

async function runCompiled(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([compiledBin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.replace(/\r\n/g, "\n"), stderr, exitCode };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "kesha-compiled-"));
  compiledBin = join(workDir, process.platform === "win32" ? "kesha.exe" : "kesha");
  const build = Bun.spawn(
    ["bun", "build", "--compile", `--outfile=${compiledBin}`, repoPath("bin/kesha.js")],
    { cwd: repoPath("."), stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (exitCode !== 0) throw new Error(`compiling the CLI failed (${exitCode}):\n${stderr}`);
}, 120_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("compiled CLI carries its bundled assets", () => {
  test.each(["bash", "zsh", "fish"])("completions %s prints the packaged script", async (shell) => {
    const result = await runCompiled(["completions", shell]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(readRepoFile(`completions/kesha.${shell}`));
  });

  test("manpage prints the packaged man page", async () => {
    const result = await runCompiled(["manpage"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(readRepoFile("man/kesha.1"));
  });

  test("an unknown shell is still a usage error, not a crash", async () => {
    const result = await runCompiled(["completions", "powershell"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: kesha completions <bash|zsh|fish>");
    expect(result.stdout).toBe("");
  });
});
