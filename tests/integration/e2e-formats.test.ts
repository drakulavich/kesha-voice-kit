import { mock } from "bun:test";
import { basename } from "path";

mock.module("../../src/transcribe", () => ({
  transcribe: async (audioPath: string) => {
    const name = basename(audioPath);
    if (name === "silence.wav") return "";
    if (name === "hello-english.wav") return "Hello";
    if (name === "hello-english.oga") return "Hello";
    return "test transcription";
  },
}));

import { describe, test, expect, afterAll } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { existsSync } from "fs";

afterAll(() => mock.restore());

describe("e2e-formats", () => {
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
