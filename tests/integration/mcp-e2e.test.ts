import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { engineGate } from "../helpers/model-gate";

const FIXTURE_RU = "tests/fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg";

// Presence is not usability: the #796 stub existed, ran, and failed every case here (#801).
const engineGateResult = await engineGate();
const engineInstalled = engineGateResult.installed;
if (engineGateResult.requiredFailure) {
  test("this lane must ship a functional engine (#741)", () => {
    throw new Error(engineGateResult.requiredFailure!);
  });
}

async function client() {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: "t", version: "0" });
  await cl.connect(c);
  return cl;
}

// Synthesis lives in mcp-synthesis-e2e.test.ts: it needs a Kokoro model this lane's
// installed engine may not use at all, so gating it on the engine alone left it dormant (#857).
describe.skipIf(!engineInstalled)("mcp e2e", () => {
  test("transcribe_audio returns non-empty text", async () => {
    const cl = await client();
    const res = await cl.callTool({ name: "transcribe_audio", arguments: { path: FIXTURE_RU } });
    expect(res.isError).toBeUndefined();
    // Backend-stable word: CoreML and ONNX disagree on "сообщения"/"сообщение" for this clip.
    expect((res.content as Array<{ text: string }>)[0].text).toContain("транскрипцией");
  }, 60_000);
});
