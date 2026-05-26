import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { isEngineInstalled } from "../../src/engine";

const FIXTURE_RU = "tests/fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg";

const engineInstalled = isEngineInstalled();

async function client() {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: "t", version: "0" });
  await cl.connect(c);
  return cl;
}

describe.skipIf(!engineInstalled)("mcp e2e", () => {
  test("transcribe_audio returns non-empty text", async () => {
    const cl = await client();
    const res = await cl.callTool({ name: "transcribe_audio", arguments: { path: FIXTURE_RU } });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text.length).toBeGreaterThan(0);
  }, 60_000);
});
