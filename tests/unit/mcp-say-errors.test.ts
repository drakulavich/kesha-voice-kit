import { describe, test, expect } from "bun:test";
import { join } from "path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { registerTools } from "../../src/mcp/tools";
import { tempDir } from "../helpers/temp-dir";

async function call(args: Record<string, unknown>) {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return client.callTool({ name: "synthesize_speech", arguments: args });
}

describe("synthesize_speech errors", () => {
  test("rate out of range or NaN is isError", async () => {
    const outOfRange = await call({ text: "hi", rate: 9 });
    expect(outOfRange.isError).toBe(true);
    expect((outOfRange.content as Array<{ text: string }>)[0]?.text).toBe("error [E_INVALID_ARG]: rate 9 out of range (0.5-2.0)");

    const nanRate = await call({ text: "hi", rate: NaN });
    expect(nanRate.isError).toBe(true);
  });

  test("missing models fails loud with install hint and no download", async () => {
    const prev = process.env.KESHA_CACHE_DIR;
    process.env.KESHA_CACHE_DIR = join(tempDir("kesha-mcp-empty-"), "missing");
    try {
      const res = await call({ text: "hello", voice: "en-am_michael" });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0]?.text).toMatch(/install --tts|not installed|kesha-engine not installed/i);
    } finally {
      if (prev === undefined) delete process.env.KESHA_CACHE_DIR;
      else process.env.KESHA_CACHE_DIR = prev;
    }
  });
});

describe("a call cancelled before it starts (#1381)", () => {
  type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  const handlers: Record<string, Handler> = {};
  registerTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => (handlers[name] = handler),
    registerResource: () => {},
  } as never);

  test.each(["synthesize_speech", "transcribe_audio"])("%s reports E_INTERRUPTED", async (name) => {
    const res = await handlers[name]!({ text: "hi", path: "/x.ogg" }, { signal: AbortSignal.abort() });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("error [E_INTERRUPTED]: request cancelled");
  });
});
