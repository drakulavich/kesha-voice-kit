import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { listVoices } from "../../src/mcp/voices";

const skipOnWin32 = process.platform === "win32" ? test.skip : test;

async function withEngineBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.KESHA_ENGINE_BIN;
  process.env.KESHA_ENGINE_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = prevBin;
  }
}

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

    await withEngineBin(notExecutable, async () => {
      const res = await call("list_voices");
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("E_ENGINE_SPAWN");
      expect(text).toContain(notExecutable);
    });
  });
});

// A stub, because gating on an installed engine skipped these in every CI lane (#984).
function voiceListingEngine(voiceIds: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-voices-"));
  const path = join(dir, "kesha-engine");
  const args = voiceIds.map((id) => `'${id}'`).join(" ");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "say" ] && [ "$2" = "--list-voices" ]; then\n  printf '%s\\n' ${args}\n  exit 0\nfi\nexit 2\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const STUB_VOICES = ["en-am_michael", "en-bf_emma", "ru-vosk-m02"];

describe("list_voices tool", () => {
  skipOnWin32("returns structured voices with new schema", async () => {
    await withEngineBin(voiceListingEngine(STUB_VOICES), async () => {
      const res = await call("list_voices");
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
      expect(sc.voices.map((v) => v.voiceId)).toEqual(STUB_VOICES);
    });
  });
});

describe("list_languages tool", () => {
  skipOnWin32("returns structured languages", async () => {
    await withEngineBin(voiceListingEngine(STUB_VOICES), async () => {
      const res = await call("list_languages");
      expect(res.isError).toBeUndefined();
      const sc = res.structuredContent as {
        languages: Array<{ languageCode: string; languageName: string; voiceCount: number }>;
      };
      expect(sc.languages).toEqual([
        { languageCode: "en-GB", languageName: "British English", voiceCount: 1 },
        { languageCode: "en-US", languageName: "American English", voiceCount: 1 },
        { languageCode: "ru", languageName: "Russian", voiceCount: 1 },
      ]);
    });
  });
});
