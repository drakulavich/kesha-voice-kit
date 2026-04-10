import { describe, test, expect } from "bun:test";

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir + "/../..",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("e2e-cli", () => {
  test("--version prints version and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("install --help shows install flags", async () => {
    const { stdout, exitCode } = await runCli(["install", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--coreml");
    expect(stdout).toContain("--onnx");
    expect(stdout).toContain("--no-cache");
  });

  test("status prints runtime status and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ONNX:");
    expect(stdout).toContain("Runtime");
  });

  test("no args prints usage and exits 1", async () => {
    const { stdout, exitCode } = await runCli([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage:");
  });

  test("missing file prints error and exits 1", async () => {
    const { stderr, exitCode } = await runCli(["nonexistent.wav"]);
    expect(exitCode).toBe(1);
    expect(stderr.toLowerCase()).toContain("file not found");
  });

  test("multiple missing files prints all errors and exits 1", async () => {
    const { stderr, exitCode } = await runCli(["a.wav", "b.wav"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("a.wav");
    expect(stderr).toContain("b.wav");
  });

  test("multiple missing files with --json outputs empty JSON array", async () => {
    const { stdout, stderr, exitCode } = await runCli(["--json", "a.wav", "b.wav"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr).toContain("a.wav");
    expect(stderr).toContain("b.wav");
  });

  test("install rejects conflicting backend flags", async () => {
    const { stderr, exitCode } = await runCli(["install", "--coreml", "--onnx"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Choose only one backend');
  });
});
