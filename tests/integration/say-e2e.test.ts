import { describe, it, expect, beforeAll } from "bun:test";
import { spawn } from "bun";
import { existsSync, mkdirSync, symlinkSync } from "fs";

const CLI_PATH = new URL("../../bin/kesha.js", import.meta.url).pathname;

/**
 * End-to-end: run the full `kesha say` CLI with a populated cache that points
 * at the spike-downloaded Kokoro model + af_heart voice. Skipped if the spike
 * artifacts are missing (set up with `cd rust/spike-kokoro && ...` from Task 0.2).
 */
const SPIKE_MODEL = process.env.KOKORO_MODEL ?? "/tmp/kokoro-spike/model.onnx";
const SPIKE_VOICE = process.env.KOKORO_VOICE ?? "/tmp/kokoro-spike/af_heart.bin";
// G2P source dir lives under the inherited KESHA_CACHE_DIR (CI runner
// layout). Required since #123 Phase 2a — Kokoro pipes through ONNX G2P.
const G2P_SRC_DIR = process.env.KESHA_CACHE_DIR
  ? `${process.env.KESHA_CACHE_DIR}/models/g2p/byt5-tiny`
  : "";
const G2P_AVAILABLE =
  G2P_SRC_DIR !== "" && existsSync(`${G2P_SRC_DIR}/encoder_model.onnx`);
const SPIKE_AVAILABLE = existsSync(SPIKE_MODEL) && existsSync(SPIKE_VOICE) && G2P_AVAILABLE;

const CACHE_DIR = `/tmp/kesha-e2e-${Date.now()}`;
const MODEL_DIR = `${CACHE_DIR}/models/kokoro-82m`;
const G2P_DIR = `${CACHE_DIR}/models/g2p/byt5-tiny`;
const BUILT_ENGINE = `${new URL("../..", import.meta.url).pathname}rust/target/release/kesha-engine`;

beforeAll(() => {
  if (!SPIKE_AVAILABLE) return;
  mkdirSync(`${MODEL_DIR}/voices`, { recursive: true });
  symlinkSync(SPIKE_MODEL, `${MODEL_DIR}/model.onnx`);
  symlinkSync(SPIKE_VOICE, `${MODEL_DIR}/voices/af_heart.bin`);
  mkdirSync(G2P_DIR, { recursive: true });
  for (const f of ["encoder_model.onnx", "decoder_model.onnx", "decoder_with_past_model.onnx"]) {
    symlinkSync(`${G2P_SRC_DIR}/${f}`, `${G2P_DIR}/${f}`);
  }
});

function spawnCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawn(["bun", CLI_PATH, ...args], {
    env: {
      ...process.env,
      KESHA_CACHE_DIR: CACHE_DIR,
      KESHA_ENGINE_BIN: BUILT_ENGINE,
      DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("kesha say e2e", () => {
  it.skipIf(!SPIKE_AVAILABLE)(
    "produces valid WAV for 'Hello' via full CLI pipeline",
    async () => {
      const proc = spawnCli(["say", "Hello"]);
      const exit = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(exit).toBe(0);
      const stdoutBuf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      expect(new TextDecoder().decode(stdoutBuf.slice(0, 4))).toBe("RIFF");
      expect(stdoutBuf.length).toBeGreaterThan(10_000);
      expect(stderr).not.toMatch(/panic|abort|thread '.+' panicked/);
    },
    60_000,
  );

  it.skipIf(!SPIKE_AVAILABLE)(
    "writes WAV to --out file",
    async () => {
      const outPath = `/tmp/kesha-e2e-out-${Date.now()}.wav`;
      const proc = spawnCli(["say", "Hi", "--out", outPath]);
      expect(await proc.exited).toBe(0);
      const bytes = await Bun.file(outPath).arrayBuffer();
      expect(new TextDecoder().decode(new Uint8Array(bytes, 0, 4))).toBe("RIFF");
    },
    60_000,
  );

  // Replaces tests/unit/log.test.ts (spy-based on our own console.error,
  // violated Fowler's "mock only at trust boundaries" rule — see #161). The
  // real contract is "KESHA_DEBUG=1 → [debug] traces on stderr; otherwise
  // silent"; verify it by spawning the CLI and grepping stderr.
  it.skipIf(!SPIKE_AVAILABLE)(
    "KESHA_DEBUG=1 emits [debug] traces on stderr",
    async () => {
      const outPath = `/tmp/kesha-debug-${Date.now()}.wav`;
      const proc = spawnCli(["say", "Hi", "--out", outPath], { KESHA_DEBUG: "1" });
      expect(await proc.exited).toBe(0);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("[debug]");
    },
    60_000,
  );

  it.skipIf(!SPIKE_AVAILABLE)(
    "empty KESHA_DEBUG → stderr is free of [debug] markers",
    async () => {
      const outPath = `/tmp/kesha-nodebug-${Date.now()}.wav`;
      const proc = spawnCli(["say", "Hi", "--out", outPath], { KESHA_DEBUG: "" });
      expect(await proc.exited).toBe(0);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).not.toContain("[debug]");
    },
    60_000,
  );
});
