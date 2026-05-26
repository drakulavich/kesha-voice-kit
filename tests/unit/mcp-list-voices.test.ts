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
  test.skipIf(!engineAvailable)("returns structured voices", async () => {
    const server = createKeshaMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const res = await client.callTool({ name: "list_voices", arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { voices: Array<{ id: string; engine: string }> };
    expect(Array.isArray(sc.voices)).toBe(true);
    expect(sc.voices.length).toBeGreaterThan(0);
    expect(sc.voices[0]).toHaveProperty("engine");
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
