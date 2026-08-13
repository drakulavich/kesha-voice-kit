import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { listVoices } from "../../src/mcp/voices";

const skipOnWin32 = process.platform === "win32" ? test.skip : test;

async function call(name: string, args: Record<string, unknown> = {}) {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return client.callTool({ name, arguments: args });
}

async function withMissingEngine<T>(fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.KESHA_ENGINE_BIN;
  const prevCache = process.env.KESHA_CACHE_DIR;
  delete process.env.KESHA_ENGINE_BIN;
  process.env.KESHA_CACHE_DIR = `/tmp/kesha-mcp-empty-${Date.now()}-${Math.random()}`;
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = prevBin;
    if (prevCache === undefined) delete process.env.KESHA_CACHE_DIR;
    else process.env.KESHA_CACHE_DIR = prevCache;
  }
}

describe("list_voices / list_languages guard when the engine is missing", () => {
  test("listVoices() throws an install-hint error, not a raw spawn exception", async () => {
    await withMissingEngine(async () => {
      await expect(listVoices()).rejects.toThrow(/kesha-engine not installed. run: (kesha install|kesha init)$/);
    });
  });

  test("list_voices tool returns isError with the install hint", async () => {
    await withMissingEngine(async () => {
      const res = await call("list_voices");
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0]?.text).toContain("kesha-engine not installed");
    });
  });

  test("list_languages tool returns isError with the install hint", async () => {
    await withMissingEngine(async () => {
      const res = await call("list_languages");
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0]?.text).toContain("kesha-engine not installed");
    });
  });
});

describe("list_voices guard when the engine is present but not executable", () => {
  skipOnWin32("list_voices tool returns isError with E_ENGINE_SPAWN, not a raw spawn exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-not-exec-"));
    const notExecutable = join(dir, "kesha-engine");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);

    const prevBin = process.env.KESHA_ENGINE_BIN;
    process.env.KESHA_ENGINE_BIN = notExecutable;
    try {
      const res = await call("list_voices");
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("E_ENGINE_SPAWN");
      expect(text).toContain(notExecutable);
    } finally {
      if (prevBin === undefined) delete process.env.KESHA_ENGINE_BIN;
      else process.env.KESHA_ENGINE_BIN = prevBin;
    }
  });
});

// Skip the full tool test if the engine is not installed (unit environment).
// The integration path (tests/integration/) covers the full round-trip with a
// real engine binary.
// Guarding on "any voice" let a Russian-only `--tts ru` install run the English assertions.
let engineAvailable = false;
try {
  engineAvailable = (await listVoices()).some((v) => v.voiceId === "en-am_michael");
} catch {
  engineAvailable = false;
}

describe("list_voices tool", () => {
  test.skipIf(!engineAvailable)("returns structured voices with new schema", async () => {
    const server = createKeshaMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const res = await client.callTool({ name: "list_voices", arguments: {} });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as {
      voices: Array<{ voiceId: string; modelId: string; modelName: string; languageCode: string; languageName: string; gender: string | null }>;
    };
    // The English default is a brand contract; naming it pins every field, BCP-47 tag included.
    expect(sc.voices.find((v) => v.voiceId === "en-am_michael")).toEqual({
      voiceId: "en-am_michael",
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode: "en-US",
      languageName: "American English",
      gender: "male",
    });
  });
});

describe("list_languages tool", () => {
  test.skipIf(!engineAvailable)("returns structured languages", async () => {
    const server = createKeshaMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const res = await client.callTool({ name: "list_languages", arguments: {} });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as {
      languages: Array<{ languageCode: string; languageName: string; voiceCount: number }>;
    };
    expect(sc.languages.find((l) => l.languageCode === "en-US")).toMatchObject({
      languageCode: "en-US",
      languageName: "American English",
    });

    // Cross-tool agreement, not a re-implementation; the maths has its oracle in mcp-voices.
    const voicesRes = await client.callTool({ name: "list_voices", arguments: {} });
    const listed = (voicesRes.structuredContent as { voices: Array<{ languageCode: string }> }).voices;
    for (const lang of sc.languages) {
      expect(lang.voiceCount).toBe(listed.filter((v) => v.languageCode === lang.languageCode).length);
    }
  });
});
