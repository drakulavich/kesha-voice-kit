import { describe, test, expect } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { isModelInstalled } from "../../src/models";
import { existsSync } from "fs";
import { spawnSync } from "child_process";

const modelsReady = isModelInstalled();
const fixtureExists = existsSync("fixtures/hello-english.wav");
const hasSpeech = spawnSync("which", ["espeak-ng"]).status === 0;

describe.skipIf(!fixtureExists || !modelsReady)("e2e-english", () => {
  test("transcribes English audio", async () => {
    const text = await transcribe("fixtures/hello-english.wav");

    if (hasSpeech) {
      expect(text.trim().length).toBeGreaterThan(0);
    } else {
      expect(text).toBe("");
    }
  }, 120_000);
});
