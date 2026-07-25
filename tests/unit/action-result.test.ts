import { afterEach, describe, expect, test } from "bun:test";
import { emitActionResult } from "../../src/cli/action-result";

// The rejected path calls process.exit; cli-contracts.test.ts covers it end-to-end.
describe("emitActionResult", () => {
  const savedLog = console.log;
  const savedStdout = process.stdout.write;
  const savedStderr = process.stderr.write;

  afterEach(() => {
    console.log = savedLog;
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
  });

  function capture(): { stdout: string[]; stderr: string[]; raw: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const raw: string[] = [];
    console.log = (msg: string) => stdout.push(msg);
    process.stdout.write = ((chunk: string) => {
      raw.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    return { stdout, stderr, raw };
  }

  test("info and success go to stdout, warn to stderr", () => {
    const sink = capture();
    emitActionResult({
      ok: true,
      messages: [
        { level: "success", text: "enabled" },
        { level: "info", text: "Database: /tmp/x" },
        { level: "warn", text: "heads up" },
      ],
    });

    expect(sink.stdout.some((l) => l.includes("enabled"))).toBe(true);
    expect(sink.stdout.some((l) => l.includes("Database: /tmp/x"))).toBe(true);
    expect(sink.stderr.some((l) => l.includes("heads up"))).toBe(true);
  });

  test("stdout payloads are written verbatim, without a log prefix or newline", () => {
    const sink = capture();
    emitActionResult({ ok: true, messages: [], stdout: '{"a":1}' });

    expect(sink.raw).toEqual(['{"a":1}']);
    expect(sink.stdout).toEqual([]);
  });

  test("an empty result prints nothing", () => {
    const sink = capture();
    emitActionResult({ ok: true, messages: [] });

    expect(sink.stdout).toEqual([]);
    expect(sink.raw).toEqual([]);
    expect(sink.stderr).toEqual([]);
  });
});
