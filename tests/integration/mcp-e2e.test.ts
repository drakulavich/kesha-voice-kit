import { describe, test, expect, beforeAll } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync, mkdirSync, symlinkSync } from "fs";
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

// TTS model availability — mirrors say-e2e.test.ts gating
const SPIKE_MODEL = process.env.KOKORO_MODEL ?? "/tmp/kokoro-spike/model.onnx";
const SPIKE_VOICE = process.env.KOKORO_VOICE ?? "/tmp/kokoro-spike/af_heart.bin";
const G2P_SRC_DIR = process.env.KESHA_CACHE_DIR
  ? `${process.env.KESHA_CACHE_DIR}/models/g2p/byt5-tiny`
  : "";
const G2P_AVAILABLE =
  G2P_SRC_DIR !== "" && existsSync(`${G2P_SRC_DIR}/encoder_model.onnx`);
const SPIKE_AVAILABLE = existsSync(SPIKE_MODEL) && existsSync(SPIKE_VOICE) && G2P_AVAILABLE;

const TTS_CACHE_DIR = `/tmp/kesha-mcp-e2e-${Date.now()}`;
const MODEL_DIR = `${TTS_CACHE_DIR}/models/kokoro-82m`;
const G2P_DIR = `${TTS_CACHE_DIR}/models/g2p/byt5-tiny`;

beforeAll(() => {
  if (!SPIKE_AVAILABLE) return;
  mkdirSync(`${MODEL_DIR}/voices`, { recursive: true });
  symlinkSync(SPIKE_MODEL, `${MODEL_DIR}/model.onnx`);
  symlinkSync(SPIKE_VOICE, `${MODEL_DIR}/voices/af_heart.bin`);
  mkdirSync(G2P_DIR, { recursive: true });
  for (const f of ["encoder_model.onnx", "decoder_model.onnx", "decoder_with_past_model.onnx"]) {
    symlinkSync(`${G2P_SRC_DIR}/${f}`, `${G2P_DIR}/${f}`);
  }
  process.env.KESHA_CACHE_DIR = TTS_CACHE_DIR;
});

describe.skipIf(!engineInstalled)("mcp e2e", () => {
  test("transcribe_audio returns non-empty text", async () => {
    const cl = await client();
    const res = await cl.callTool({ name: "transcribe_audio", arguments: { path: FIXTURE_RU } });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text.length).toBeGreaterThan(0);
  }, 60_000);

  test.skipIf(!SPIKE_AVAILABLE)(
    "synthesize_speech returns a readable resource_link to a valid file",
    async () => {
      const cl = await client();
      const res = await cl.callTool({
        name: "synthesize_speech",
        arguments: { text: "Hello world", voice: "en-am_michael", format: "wav" },
      });
      expect(res.isError).toBeFalsy();
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
