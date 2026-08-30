import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyBackpressure, streamResponseToFile } from "../../src/progress";

const posixTest = process.platform === "win32" ? test.skip : test;

// #216: `writer.end()` went unawaited, so the write handle outlived the call. Whether an
// OS then lets you spawn the file is nondeterministic — that half is covered by
// windows-engine-smoke against a real PE and absorbed by `waitUntilSpawnable`.

function responseOf(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
}

describe("streamResponseToFile flushes before resolving", () => {
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

  // Backpressure handling sits in the write loop, so a mishandled sentinel could drop or
  // reorder a chunk without changing the byte count — compare content, not just length.
  test("a multi-chunk body round-trips byte for byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-large-"));
    try {
      const dest = join(dir, "payload.bin");
      const source = new Uint8Array(8 * 1024 * 1024);
      for (let i = 0; i < source.length; i++) source[i] = i % 251;

      const written = await streamResponseToFile(
        new Response(source, { headers: { "content-length": String(source.length) } }),
        dest,
        "payload",
      );

      expect(written).toBe(source.length);
      const back = new Uint8Array(await Bun.file(dest).arrayBuffer());
      expect(back.length).toBe(source.length);
      expect(Bun.SHA256.hash(back, "hex")).toBe(Bun.SHA256.hash(source, "hex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("streamResponseToFile publishes atomically (#770)", () => {
  /** Streams `prefix`, then fails — the shape of a Ctrl-C or a dropped connection mid-download. */
  function failingResponse(prefix: string, message: string): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        controller.error(new Error(message));
      },
    });
    return new Response(body, { headers: { "content-length": "999999" } });
  }

  test("an interrupted download leaves the previous file untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-abort-"));
    try {
      const dest = join(dir, "kesha-engine");
      writeFileSync(dest, "previous engine");

      await expect(
        streamResponseToFile(failingResponse("truncated", "connection reset"), dest, "payload"),
      ).rejects.toThrow(/connection reset/);

      expect(readFileSync(dest, "utf8")).toBe("previous engine");
      expect(readdirSync(dir)).toEqual(["kesha-engine"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an interrupted first download leaves no file at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-abort-cold-"));
    try {
      const dest = join(dir, "kesha-engine");

      await expect(
        streamResponseToFile(failingResponse("truncated", "connection reset"), dest, "payload"),
      ).rejects.toThrow(/connection reset/);

      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a successful download leaves no staging file behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-staging-"));
    try {
      const dest = join(dir, "kesha-engine");

      await streamResponseToFile(responseOf("engine bytes"), dest, "payload");

      expect(readFileSync(dest, "utf8")).toBe("engine bytes");
      expect(readdirSync(dir)).toEqual(["kesha-engine"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A Ctrl-C kills the process before cleanup runs, so the next download has to sweep.
  // The sweep is Unix-only and age-gated, exactly as models/download.rs::cleanup_orphan_staging is.
  posixTest("a staging file orphaned by a killed process is swept once it is a day old", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-orphan-"));
    try {
      const dest = join(dir, "kesha-engine");
      const orphan = `${dest}.part.4242.3`;
      writeFileSync(orphan, "orphan from a killed run");
      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(orphan, dayAgo, dayAgo);

      await streamResponseToFile(responseOf("engine bytes"), dest, "payload");

      expect(readdirSync(dir)).toEqual(["kesha-engine"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Two concurrent `kesha install` runs: sweeping B's in-flight staging leaves B renaming an
  // unlinked inode. Only age tells a live download apart from an orphan.
  test("a concurrent installer's fresh staging file survives the sweep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-live-"));
    try {
      const dest = join(dir, "kesha-engine");
      const live = `${dest}.part.999`;
      writeFileSync(live, "another process is still writing this");

      await streamResponseToFile(responseOf("engine bytes"), dest, "payload");

      expect(readFileSync(live, "utf8")).toBe("another process is still writing this");
      expect(readdirSync(dir).sort()).toEqual(["kesha-engine", "kesha-engine.part.999"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Yields the body a chunk at a time, so two of these genuinely interleave. */
  function slowResponse(body: string): Response {
    const chunks = body.match(/.{1,16}/g) ?? [];
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        await Bun.sleep(5);
        controller.enqueue(new TextEncoder().encode(chunks[next++]!));
      },
    });
    return new Response(stream, { headers: { "content-length": String(body.length) } });
  }

  // The pid tells processes apart, not calls within one — two concurrent programmatic
  // downloads of the same file would otherwise share a staging path and clobber each other.
  test("two concurrent downloads of one destination get their own staging files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-concurrent-"));
    try {
      const dest = join(dir, "kesha-engine");
      const first = "a".repeat(128);
      const second = "b".repeat(128);

      await Promise.all([
        streamResponseToFile(slowResponse(first), dest, "first"),
        streamResponseToFile(slowResponse(second), dest, "second"),
      ]);

      expect([first, second]).toContain(readFileSync(dest, "utf8"));
      expect(readdirSync(dir)).toEqual(["kesha-engine"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing destination is replaced with the new bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-overwrite-"));
    try {
      const dest = join(dir, "kesha-engine");
      writeFileSync(dest, "stale engine from an older release");

      await streamResponseToFile(responseOf("fresh engine bytes"), dest, "payload");

      expect(readFileSync(dest, "utf8")).toBe("fresh engine bytes");
      expect(readdirSync(dir)).toEqual(["kesha-engine"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the published file carries the mode the caller then chmods", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-mode-"));
    try {
      const dest = join(dir, "kesha-engine");

      await streamResponseToFile(responseOf("engine bytes"), dest, "payload");
      chmodSync(dest, 0o755);

      expect(statSync(dest).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyBackpressure honours the FileSink contract (#669)", () => {
  function fakeSink() {
    let flushes = 0;
    return {
      flush: () => {
        flushes += 1;
        return 0;
      },
      get flushes() {
        return flushes;
      },
    };
  }

  test("an inline write needs no flush", async () => {
    const sink = fakeSink();
    await applyBackpressure(sink, 4096);
    expect(sink.flushes).toBe(0);
  });

  // Bun encodes backpressure as -(bytes + 1); ignoring it buffers the whole download.
  test("the negative sentinel drains the sink", async () => {
    const sink = fakeSink();
    await applyBackpressure(sink, -(65_536 + 1));
    expect(sink.flushes).toBe(1);
  });

  test("a pending write is awaited rather than dropped", async () => {
    const sink = fakeSink();
    let settled = false;
    const pending = new Promise<number>((resolve) =>
      setTimeout(() => {
        settled = true;
        resolve(4096);
      }, 10),
    );

    await applyBackpressure(sink, pending);

    expect(settled).toBe(true);
    expect(sink.flushes).toBe(0);
  });

  test("zero bytes written is not mistaken for backpressure", async () => {
    const sink = fakeSink();
    await applyBackpressure(sink, 0);
    expect(sink.flushes).toBe(0);
  });
});

describe("the sweep only claims its own destination's staging", () => {
  // One `kesha install` downloads the engine and both sidecars into the same bin dir, so a
  // sweep keyed on the directory rather than the destination would eat a sibling's staging.
  posixTest("a stale staging file belonging to another download is left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-sibling-"));
    try {
      const dest = join(dir, "kesha-engine");
      const sibling = join(dir, "kesha-textlang.part.4242.0");
      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      writeFileSync(sibling, "another asset's orphan");
      utimesSync(sibling, dayAgo, dayAgo);

      await streamResponseToFile(responseOf("engine bytes"), dest, "payload");

      expect(readFileSync(sibling, "utf8")).toBe("another asset's orphan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixTest("an unrelated stale file next to the destination is left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-unrelated-"));
    try {
      const dest = join(dir, "kesha-engine");
      const bystander = join(dir, "kesha-engine.version");
      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      writeFileSync(bystander, "1.24.9\n");
      utimesSync(bystander, dayAgo, dayAgo);

      await streamResponseToFile(responseOf("engine bytes"), dest, "payload");

      expect(readFileSync(bystander, "utf8")).toBe("1.24.9\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a download with nothing to stream fails with a fix", () => {
  test("an empty response body names the label and what to do", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stream-empty-"));
    try {
      const dest = join(dir, "kesha-engine");
      const promise = streamResponseToFile(new Response(null), dest, "kesha-engine binary");
      await expect(promise).rejects.toThrow("empty response for kesha-engine binary");
      await expect(promise).rejects.toThrow("Try again");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
