import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { streamResponseToFile } from "../../src/progress";

// #216: `writer.end()` went unawaited, so the write handle outlived the call and
// the just-downloaded engine could not be spawned — EBUSY on Windows, ETXTBSY on
// Linux. The contract is that the file is complete AND released once this resolves.
const spawnTest = process.platform === "win32" ? test.skip : test;

function responseOf(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
}

describe("streamResponseToFile releases the file before resolving", () => {
  test("the full payload is on disk when the promise resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-"));
    try {
      const dest = join(dir, "payload.bin");
      const body = "x".repeat(512 * 1024);

      const written = await streamResponseToFile(responseOf(body), dest, "payload");

      expect(written).toBe(body.length);
      expect(statSync(dest).size).toBe(body.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  spawnTest("a downloaded executable is spawnable immediately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-exec-"));
    try {
      const dest = join(dir, "helper");

      await streamResponseToFile(responseOf("#!/bin/sh\nexit 0\n"), dest, "helper");
      chmodSync(dest, 0o755);

      const proc = Bun.spawn([dest], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      expect({ code: await proc.exited, stderr }).toEqual({ code: 0, stderr: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
