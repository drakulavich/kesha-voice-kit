import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";

async function call(args: Record<string, unknown>) {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return client.callTool({ name: "synthesize_speech", arguments: args });
}

describe("synthesize_speech errors", () => {
  test("rate out of range is isError", async () => {
    const res = await call({ text: "hi", rate: 9 });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/rate/i);
  });

  test("NaN rate is isError", async () => {
    const res = await call({ text: "hi", rate: NaN });
    expect(res.isError).toBe(true);
  });

  test("missing models fails loud with install hint and no download", async () => {
    const prev = process.env.KESHA_CACHE_DIR;
    process.env.KESHA_CACHE_DIR = "/tmp/kesha-mcp-empty-" + Date.now();
    try {
      const res = await call({ text: "hello", voice: "en-am_michael" });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0].text).toMatch(/install --tts|not installed|kesha-engine not installed/i);
    } finally {
      if (prev === undefined) delete process.env.KESHA_CACHE_DIR;
      else process.env.KESHA_CACHE_DIR = prev;
    }
  });
});
