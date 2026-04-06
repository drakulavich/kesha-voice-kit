import { describe, test, expect } from "bun:test";
import { convertToFloat32PCM } from "../audio";
import { spawnSync } from "child_process";

const hasFfmpeg = spawnSync("which", ["ffmpeg"]).status === 0;

describe.skipIf(!hasFfmpeg)("audio", () => {
  test("converts WAV to 16kHz mono Float32Array", async () => {
    const buffer = await convertToFloat32PCM("fixtures/silence.wav");
    expect(buffer).toBeInstanceOf(Float32Array);
    // 1 second at 16kHz = 16000 samples
    expect(buffer.length).toBeGreaterThan(15000);
    expect(buffer.length).toBeLessThan(17000);
  });

  test("throws on missing file", async () => {
    expect(convertToFloat32PCM("nonexistent.wav")).rejects.toThrow(
      "file not found"
    );
  });

  test("throws on corrupt file", async () => {
    await Bun.write("fixtures/corrupt.bin", "not audio data");
    expect(convertToFloat32PCM("fixtures/corrupt.bin")).rejects.toThrow(
      "failed to convert audio"
    );
  });
});
