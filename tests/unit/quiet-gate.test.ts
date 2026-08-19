import { describe, expect, test } from "bun:test";
import { runQuiet } from "../../scripts/quiet-gate";

const SCRIPT = new URL("../../scripts/quiet-gate.ts", import.meta.url).pathname;

async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("runQuiet", () => {
  test("keeps the two streams in the order the command wrote them", async () => {
    // Separate pipes would report both streams whole, and a failing gate's error would read as
    // if it happened after output that actually followed it.
    const result = await runQuiet(["bash", "-c", "echo one; echo two >&2; echo three"]);

    expect(result.log).toBe("one\ntwo\nthree\n");
  });

  test("propagates the command's exit code", async () => {
    expect((await runQuiet(["bash", "-c", "exit 7"])).exitCode).toBe(7);
  });

  test("reports a command that could not start rather than calling it a pass", async () => {
    const result = await runQuiet(["kesha-no-such-binary"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.log).toContain("kesha-no-such-binary");
  });
});

describe("quiet-gate cli", () => {
  test("a passing gate reports one line and not the output it swallowed", async () => {
    const result = await cli(["unit", "--", "bash", "-c", "echo 1339 pass; echo 9 skip"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("unit");
    expect(result.stdout).not.toContain("1339 pass");
    expect(result.stderr).not.toContain("1339 pass");
  });

  test("a failing gate prints what it ran verbatim, so the failure is never swallowed", async () => {
    const result = await cli(["unit", "--", "bash", "-c", "echo 1 fail; echo boom >&2; exit 3"]);

    expect(result.code).toBe(3);
    expect(`${result.stdout}${result.stderr}`).toContain("1 fail");
    expect(`${result.stdout}${result.stderr}`).toContain("boom");
  });

  test("refuses a call with no command instead of reporting an empty gate as green", async () => {
    const result = await cli(["unit"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});
