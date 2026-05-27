import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { listVoices } from "../../src/mcp/voices";

// Skip the full tool test if the engine is not installed (unit environment).
// The integration path (tests/integration/) covers the full round-trip with a
// real engine binary.
let engineAvailable = false;
try {
  const voices = await listVoices();
  engineAvailable = voices.length > 0;
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
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      voices: Array<{ voiceId: string; modelId: string; modelName: string; languageCode: string; languageName: string; gender: string | null }>;
    };
    expect(Array.isArray(sc.voices)).toBe(true);
    expect(sc.voices.length).toBeGreaterThan(0);
    expect(sc.voices[0]).toHaveProperty("voiceId");
    expect(sc.voices[0]).toHaveProperty("modelId");
    expect(sc.voices[0]).toHaveProperty("modelName");
    expect(sc.voices[0]).toHaveProperty("languageCode");
    expect(sc.voices[0]).toHaveProperty("languageName");
    expect(sc.voices[0]).toHaveProperty("gender");
  });

  test("tool is listed in tools/list", async () => {
    const server = createKeshaMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_voices");
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
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      languages: Array<{ languageCode: string; languageName: string; voiceCount: number }>;
    };
    expect(Array.isArray(sc.languages)).toBe(true);
    expect(sc.languages.length).toBeGreaterThan(0);
    expect(sc.languages[0]).toHaveProperty("languageCode");
    expect(sc.languages[0]).toHaveProperty("languageName");
    expect(sc.languages[0]).toHaveProperty("voiceCount");
    expect(typeof sc.languages[0].voiceCount).toBe("number");
  });

  test("tool is listed in tools/list", async () => {
    const server = createKeshaMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_languages");
  });
});
