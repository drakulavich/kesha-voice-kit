import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { describeJson, saveEngineEnv } from "../helpers/fake-engine";
import { waitForPidExit, waitForPidFile } from "../helpers/process";
import { tempDir } from "../helpers/temp-dir";

/** Answers `describe`, then hangs on `transcribe` and `say` after writing its pid, so the test can see whether anything stops it. */
function hangingEngine(dir: string, pidPath: string): string {
  const enginePath = join(dir, "kesha-engine");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ features: ["tts"] }))});
  process.exit(0);
}
if (args[0] === "transcribe" || args[0] === "say") {
  await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

async function connect() {
  const server = createKeshaMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientTransport);
  return { client, server };
}

// Exploratory S7-1: a cancelled call released the client but let the engine run the job to completion,
// and every further cancel stacked another live engine that only server exit reaped.
describe.skipIf(process.platform === "win32")("MCP request cancellation", () => {
  let restoreEnv: () => void;
  let dir: string;
  let pidPath: string;
  let audio: string;

  beforeEach(() => {
    restoreEnv = saveEngineEnv();
    dir = tempDir("kesha-mcp-cancel-");
    pidPath = join(dir, "engine.pid");
    audio = join(dir, "audio.wav");
    writeFileSync(audio, "");
    process.env.KESHA_HOME = dir;
    process.env.KESHA_ENGINE_BIN = hangingEngine(dir, pidPath);
  });

  afterEach(() => restoreEnv());

  const calls: Array<[string, () => Record<string, unknown>]> = [
    ["transcribe_audio", () => ({ path: audio })],
    ["synthesize_speech", () => ({ text: "hello", voice: "en-am_michael" })],
  ];

  test.each(calls)("cancelling %s stops the engine it started", async (name, args) => {
    const { client, server } = await connect();
    try {
      const controller = new AbortController();
      const call = client.callTool({ name, arguments: args() }, undefined, { signal: controller.signal });
      const enginePid = await waitForPidFile(pidPath);

      controller.abort();
      await call.catch(() => {});

      expect(await waitForPidExit(enginePid)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  }, 30_000);
});
