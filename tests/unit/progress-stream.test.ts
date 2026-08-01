import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { streamResponseToFile } from "../../src/progress";

// #216: `writer.end()` went unawaited, so the write handle outlived the call. Whether an
// OS then lets you spawn the file is nondeterministic — that half is covered by
// windows-engine-smoke against a real PE and absorbed by `waitUntilSpawnable`.

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
});
