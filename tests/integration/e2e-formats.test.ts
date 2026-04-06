import { describe, test, expect } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { isModelCached } from "../../src/models";
import { existsSync } from "fs";

const modelsReady = isModelCached("v2");

describe.skipIf(!modelsReady)("e2e-formats", () => {
  test.skipIf(!existsSync("fixtures/silence.wav"))("handles WAV input", async () => {
    const text = await transcribe("fixtures/silence.wav", { lang: "en" });
    expect(typeof text).toBe("string");
  }, 60_000);

  test.skipIf(!existsSync("fixtures/hello-english.oga"))("handles OGA input", async () => {
    const text = await transcribe("fixtures/hello-english.oga", { lang: "en" });
    expect(typeof text).toBe("string");
  }, 60_000);
});
