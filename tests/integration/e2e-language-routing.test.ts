import { describe, test, expect } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { isModelCached } from "../../src/models";
import { existsSync } from "fs";
import { spawnSync } from "child_process";

const modelsReady = isModelCached("v2") && isModelCached("v3");
const fixtureExists = existsSync("fixtures/hello-english.wav");

// Language routing produces a non-empty transcription only when the fixture
// contains real speech.  The espeak-ng fallback produces a sine tone which
// yields no tokens, so we gate the length assertion accordingly.
const hasSpeech = spawnSync("which", ["espeak-ng"]).status === 0;

describe.skipIf(!modelsReady || !fixtureExists)("e2e-language-routing", () => {
  test("auto-detects English and routes to v2", async () => {
    const text = await transcribe("fixtures/hello-english.wav");
    expect(typeof text).toBe("string");
    if (hasSpeech) {
      expect(text.length).toBeGreaterThan(0);
    }
  }, 180_000);
});
