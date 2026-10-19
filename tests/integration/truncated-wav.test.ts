import { describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { writeTranscribingEngine } from "../helpers/fake-engine";
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
    const env = { HOME: dir, KESHA_HOME: join(dir, "state"), KESHA_CACHE_DIR: join(dir, "cache"), KESHA_ENGINE_BIN: enginePath };

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
