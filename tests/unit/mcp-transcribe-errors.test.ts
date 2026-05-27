import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";

async function call(name: string, args: Record<string, unknown>) {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return client.callTool({ name, arguments: args });
}

describe("transcribe_audio errors", () => {
  test("missing file returns isError, never throws protocol error", async () => {
    const res = await call("transcribe_audio", { path: "/no/such/file.wav" });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("File not found");
  });
});
