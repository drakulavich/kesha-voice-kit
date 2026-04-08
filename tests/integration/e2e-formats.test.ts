import { describe, test, expect } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { isModelInstalled } from "../../src/models";
import { existsSync } from "fs";

const modelsReady = isModelInstalled();

describe.skipIf(!modelsReady)("e2e-formats", () => {
  test.skipIf(!existsSync("fixtures/silence.wav"))("keeps silence empty for WAV input", async () => {
    const text = await transcribe("fixtures/silence.wav");
    expect(text).toBe("");
  }, 60_000);

  test.skipIf(!existsSync("fixtures/hello-english.oga") || !existsSync("fixtures/hello-english.wav"))("produces the same transcript for OGA and WAV variants", async () => {
    const [ogaText, wavText] = await Promise.all([
      transcribe("fixtures/hello-english.oga"),
      transcribe("fixtures/hello-english.wav"),
    ]);
    expect(ogaText).toBe(wavText);
  }, 60_000);
});
