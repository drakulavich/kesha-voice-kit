import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { saveEngineEnv, writeTranscribingEngine } from "../helpers/fake-engine";
import { repoPath } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";
import { runCliScenario } from "./cli-scenario";

const scenarioTest = process.platform === "win32" ? test.skip : test;

/** 16 kHz mono 16-bit PCM whose data chunk declares `declaredBytes` and holds `presentBytes`. */
function pcmWav(declaredBytes: number, presentBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(Math.min(36 + declaredBytes, 0xffffffff), 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(declaredBytes, 40);
  return Buffer.concat([header, Buffer.alloc(presentBytes)]);
}

describe("a WAV shorter than its header says (#1473 S3-5)", () => {
  scenarioTest("transcribes with exit 0 and a stderr warning naming the file and how much is present", async () => {
    const dir = tempDir("kesha-truncated-wav-");
    const enginePath = writeTranscribingEngine("kesha-truncated-wav-engine-", ["transcribe"], "  printf '%s\\n' 'ok'");
    const half = join(dir, "half.wav");
    const whole = join(dir, "whole.wav");
    const streamed = join(dir, "streamed.wav");
    writeFileSync(half, pcmWav(32000, 16000));
    writeFileSync(whole, pcmWav(32000, 32000));
    writeFileSync(streamed, pcmWav(0xffffffff, 32000));
    const env = {
      HOME: dir,
      KESHA_HOME: join(dir, "state"),
      KESHA_CACHE_DIR: join(dir, "cache"),
      KESHA_ENGINE_BIN: enginePath,
    };

    const truncated = await runCliScenario([half], { env });
    expect(truncated.exitCode).toBe(0);
    expect(truncated.stdout).toContain("ok");
    expect(truncated.stderr).toContain(
      `warning: ${half} is truncated: its header declares 1.0 s of audio but the file holds 0.5 s; transcribing the part present`,
    );

    const complete = await runCliScenario([whole], { env });
    expect(complete.exitCode).toBe(0);
    expect(complete.stderr).not.toContain("is truncated");

    const unsized = await runCliScenario([streamed], { env });
    expect(unsized.exitCode).toBe(0);
    expect(unsized.stderr).not.toContain("is truncated");
  });
});

describe("--json carries the warnings stderr printed for each file (#1581)", () => {
  scenarioTest("a truncated WAV's entry has the warning, a whole one has no warnings field", async () => {
    const dir = tempDir("kesha-json-warnings-");
    const enginePath = writeTranscribingEngine("kesha-json-warnings-engine-", ["transcribe"], "  printf '%s\\n' 'ok'");
    const half = join(dir, "half.wav");
    const whole = join(dir, "whole.wav");
    writeFileSync(half, pcmWav(32000, 16000));
    writeFileSync(whole, pcmWav(32000, 32000));
    const env = { HOME: dir, KESHA_HOME: join(dir, "state"), KESHA_CACHE_DIR: join(dir, "cache"), KESHA_ENGINE_BIN: enginePath };

    const run = await runCliScenario(["--json", half, whole], { env });

    expect(run.exitCode).toBe(0);
    const [halfEntry, wholeEntry] = JSON.parse(run.stdout) as Array<{ file: string; warnings?: string[] }>;
    expect(halfEntry!.file).toBe(half);
    expect(halfEntry!.warnings).toEqual([
      `warning: ${half} is truncated: its header declares 1.0 s of audio but the file holds 0.5 s; transcribing the part present`,
    ]);
    expect(wholeEntry!.file).toBe(whole);
    expect(wholeEntry!.warnings).toBeUndefined();
  });
});

describe("a truncated WAV through the Core API and MCP (#1473 S3-5)", () => {
  scenarioTest("the Core API transcribes it and writes the warning to stderr", async () => {
    const dir = tempDir("kesha-truncated-wav-core-");
    const enginePath = writeTranscribingEngine("kesha-truncated-wav-core-engine-", ["transcribe"], "  printf '%s\\n' 'ok'", "en");
    const half = join(dir, "half.wav");
    const whole = join(dir, "whole.wav");
    writeFileSync(half, pcmWav(32000, 16000));
    writeFileSync(whole, pcmWav(32000, 32000));
    const script = `const { transcribe } = await import(${JSON.stringify(repoPath("src/lib.ts"))}); console.log((await transcribe(process.argv[1])).text);`;
    const env = {
      ...process.env,
      HOME: dir,
      KESHA_HOME: join(dir, "state"),
      KESHA_CACHE_DIR: join(dir, "cache"),
      KESHA_ENGINE_BIN: enginePath,
      NO_COLOR: "1",
    };
    const run = (file: string) => Bun.spawnSync([process.execPath, "-e", script, file], { env });

    const truncated = run(half);
    expect(truncated.exitCode).toBe(0);
    expect(truncated.stdout.toString()).toBe("ok\n");
    expect(truncated.stderr.toString()).toBe(
      `warning: ${half} is truncated: its header declares 1.0 s of audio but the file holds 0.5 s; transcribing the part present\n`,
    );

    const complete = run(whole);
    expect(complete.exitCode).toBe(0);
    expect(complete.stderr.toString()).toBe("");
  });

  scenarioTest("MCP transcribe_audio returns the transcript and the warning as a second text item", async () => {
    const restore = saveEngineEnv();
    try {
      const dir = tempDir("kesha-truncated-wav-mcp-");
      process.env.HOME = dir;
      process.env.KESHA_HOME = join(dir, "state");
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = writeTranscribingEngine("kesha-truncated-wav-mcp-engine-", ["transcribe"], "  printf '%s\\n' 'ok'");
      const half = join(dir, "half.wav");
      const whole = join(dir, "whole.wav");
      writeFileSync(half, pcmWav(32000, 16000));
      writeFileSync(whole, pcmWav(32000, 32000));
      const server = createKeshaMcpServer();
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(c);

      const truncated = await client.callTool({ name: "transcribe_audio", arguments: { path: half } });
      expect(truncated.isError).toBeFalsy();
      expect(truncated.content).toEqual([
        { type: "text", text: "ok" },
        {
          type: "text",
          text: `warning: ${half} is truncated: its header declares 1.0 s of audio but the file holds 0.5 s; transcribing the part present`,
        },
      ]);

      const complete = await client.callTool({ name: "transcribe_audio", arguments: { path: whole } });
      expect(complete.content).toEqual([{ type: "text", text: "ok" }]);
      await client.close();
    } finally {
      restore();
    }
  });
});
