import { describe, test, expect, beforeAll } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync, mkdirSync, statSync, symlinkSync } from "fs";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { modelsRequired } from "../helpers/model-gate";

/**
 * The MCP synthesis contract: a `synthesize_speech` call routes to the engine, and what
 * comes back is a readable `kesha-audio://` resource. Everything asserted here is adapter
 * plumbing — the resource_link, the `0600` mode, the byte count, the base64 read-back —
 * so it runs against the committed Kokoro stand-in and downloads nothing (#741). Audio
 * *quality* is the real-model canary's job, not this suite's.
 *
 * Split out of mcp-e2e.test.ts, which gates on the *installed* engine: on darwin-arm64
 * that is the CoreML `system_kokoro` build, where `en-*` synthesises through FluidAudio's
 * ANE assets rather than the ONNX `models/kokoro-82m` a stand-in can supply (#857).
 *
 * English Kokoro phonemises through the embedded misaki lexicon (#207), not the byt5
 * CharsiuG2P pack — gating this on a G2P artifact is what kept the old case dormant.
 */
const SPIKE_MODEL = process.env.KOKORO_MODEL ?? "/tmp/kokoro-spike/model.onnx";
const SPIKE_VOICE = process.env.KOKORO_VOICE ?? "/tmp/kokoro-spike/am_michael.bin";
const BUILT_ENGINE =
  process.env.KESHA_ENGINE_BIN ??
  `${new URL("../..", import.meta.url).pathname}rust/target/release/kesha-engine`;

const AVAILABLE = existsSync(SPIKE_MODEL) && existsSync(SPIKE_VOICE) && existsSync(BUILT_ENGINE);

/**
 * A lane that promised these models must not quietly cover nothing — the failure this
 * suite exists to prevent was a skip nobody could tell apart from a pass (#857).
 *
 * Keyed on the lane naming `KOKORO_MODEL`, not on `KESHA_REQUIRE_MODEL_TESTS` alone:
 * `integration-tests-full` sets that flag for the ASR weights it installs and stages no
 * Kokoro at all, so the broader flag would fail a lane this suite was never part of.
 */
const LANE_PROMISED_KOKORO = modelsRequired() && process.env.KOKORO_MODEL !== undefined;
if (!AVAILABLE && LANE_PROMISED_KOKORO) {
  test("this lane must stage the Kokoro stand-in and a built engine (#857)", () => {
    throw new Error(
      `This lane names KOKORO_MODEL and sets KESHA_REQUIRE_MODEL_TESTS, but the synthesis ` +
        `prerequisites are missing — model=${existsSync(SPIKE_MODEL)} ` +
        `voice=${existsSync(SPIKE_VOICE)} engine=${existsSync(BUILT_ENGINE)}. ` +
        `Skipping here would be a green run of nothing.`,
    );
  });
}

const CACHE_DIR = `/tmp/kesha-mcp-synth-${process.pid}-${Date.now()}`;
const MODEL_DIR = `${CACHE_DIR}/models/kokoro-82m`;

beforeAll(() => {
  if (!AVAILABLE) return;
  mkdirSync(`${MODEL_DIR}/voices`, { recursive: true });
  symlinkSync(SPIKE_MODEL, `${MODEL_DIR}/model.onnx`);
  // Staged under the brand-default name, because that is the voice the case requests.
  symlinkSync(SPIKE_VOICE, `${MODEL_DIR}/voices/am_michael.bin`);
  // Pin the engine before repointing the cache: `defaultEngineBinPath()` is rooted in
  // KESHA_CACHE_DIR, so a bare cache override hides the engine from the CLI side (#857).
  process.env.KESHA_ENGINE_BIN = BUILT_ENGINE;
  process.env.KESHA_CACHE_DIR = CACHE_DIR;
});

async function client() {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: "t", version: "0" });
  await cl.connect(c);
  return cl;
}

describe.skipIf(!AVAILABLE)("mcp synthesis e2e", () => {
  test(
    "synthesize_speech returns a readable resource_link to a valid file",
    async () => {
      const cl = await client();
      const res = await cl.callTool({
        name: "synthesize_speech",
        arguments: { text: "Hello world", voice: "en-am_michael", format: "wav" },
      });

      expect(res.isError).toBeUndefined();
      const link = (res.content as Array<{ type: string; uri: string }>).find(
        (c) => c.type === "resource_link",
      );
      expect(link?.uri.startsWith("kesha-audio://")).toBe(true);

      const sc = res.structuredContent as { uri: string; path: string; bytes: number };
      expect(existsSync(sc.path)).toBe(true);
      expect(statSync(sc.path).mode & 0o777).toBe(0o600);
      expect(sc.bytes).toBeGreaterThan(1000);

      const read = await cl.readResource({ uri: sc.uri });
      const blob = (read.contents[0] as { blob?: string }).blob;
      expect(typeof blob).toBe("string");
      expect(Buffer.from(blob as string, "base64").length).toBe(sc.bytes);
    },
    60_000,
  );

  test(
    "an unknown voice surfaces as a tool error, not a protocol throw",
    async () => {
      const cl = await client();
      const res = await cl.callTool({
        name: "synthesize_speech",
        arguments: { text: "Hello world", voice: "xx-nonexistent", format: "wav" },
      });
      expect(res.isError).toBe(true);
    },
    60_000,
  );
});
