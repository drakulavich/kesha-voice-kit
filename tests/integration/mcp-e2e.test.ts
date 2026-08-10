import { describe, test, expect, beforeAll } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync, mkdirSync, symlinkSync } from "fs";
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

// TTS model availability — mirrors say-e2e.test.ts gating.
//
// The synthesis case asks for `en-am_michael`, and English phonemises through the
// embedded misaki lexicon rather than the byt5 CharsiuG2P pack (#207), so no G2P
// artifact belongs in this gate. Requiring one — and staging the voice under a
// different name than the one requested — is why this case never ran in CI (#741).
const SPIKE_MODEL = process.env.KOKORO_MODEL ?? "/tmp/kokoro-spike/model.onnx";
const SPIKE_VOICE = process.env.KOKORO_VOICE ?? "/tmp/kokoro-spike/am_michael.bin";
const SPIKE_AVAILABLE = existsSync(SPIKE_MODEL) && existsSync(SPIKE_VOICE);

const TTS_CACHE_DIR = `/tmp/kesha-mcp-e2e-${Date.now()}`;
const MODEL_DIR = `${TTS_CACHE_DIR}/models/kokoro-82m`;

beforeAll(() => {
  if (!SPIKE_AVAILABLE) return;
  mkdirSync(`${MODEL_DIR}/voices`, { recursive: true });
  symlinkSync(SPIKE_MODEL, `${MODEL_DIR}/model.onnx`);
  symlinkSync(SPIKE_VOICE, `${MODEL_DIR}/voices/am_michael.bin`);
  process.env.KESHA_CACHE_DIR = TTS_CACHE_DIR;
});

describe.skipIf(!engineInstalled)("mcp e2e", () => {
  test("transcribe_audio returns non-empty text", async () => {
    const cl = await client();
    const res = await cl.callTool({ name: "transcribe_audio", arguments: { path: FIXTURE_RU } });
    expect(res.isError).toBeUndefined();
    // Backend-stable word: CoreML and ONNX disagree on "сообщения"/"сообщение" for this clip.
    expect((res.content as Array<{ text: string }>)[0].text).toContain("транскрипцией");
  }, 60_000);

  test.skipIf(!SPIKE_AVAILABLE)(
    "synthesize_speech returns a readable resource_link to a valid file",
    async () => {
      const cl = await client();
      const res = await cl.callTool({
        name: "synthesize_speech",
        arguments: { text: "Hello world", voice: "en-am_michael", format: "wav" },
      });
      expect(res.isError).toBeUndefined();
      const link = (res.content as Array<{ type: string; uri: string }>).find((c) => c.type === "resource_link");
      expect(link?.uri.startsWith("kesha-audio://")).toBe(true);
      const sc = res.structuredContent as { uri: string; path: string; bytes: number };
      const { existsSync, statSync } = await import("fs");
      expect(existsSync(sc.path)).toBe(true);
      expect((statSync(sc.path).mode & 0o777)).toBe(0o600);
      expect(sc.bytes).toBeGreaterThan(1000);
      const read = await cl.readResource({ uri: sc.uri });
      const blob = (read.contents[0] as { blob?: string }).blob;
      expect(typeof blob).toBe("string");
      expect(Buffer.from(blob as string, "base64").length).toBe(sc.bytes);
    },
    60_000,
  );
});
