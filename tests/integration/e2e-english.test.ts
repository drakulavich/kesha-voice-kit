import { describe, test, expect } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { isModelCached } from "../../src/models";
import { existsSync } from "fs";

const modelsReady = isModelCached("v2");
const fixtureExists = existsSync("fixtures/hello-english.wav");

describe.skipIf(!fixtureExists)("e2e-english", () => {
  test("transcribes English audio with v2 model", async () => {
    const text = await transcribe("fixtures/hello-english.wav", { lang: "en" });
    expect(typeof text).toBe("string");
    if (modelsReady) {
      expect(text.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
