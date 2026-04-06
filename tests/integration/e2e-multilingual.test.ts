import { describe, test, expect } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { isModelCached } from "../../src/models";
import { existsSync } from "fs";
import { spawnSync } from "child_process";

const fixtureExists = existsSync("fixtures/hello-spanish.wav");

// Detect whether the fixture was generated with real speech (espeak-ng) or is
// a synthetic sine-tone fallback.  Only espeak-ng produces intelligible audio
// that should yield a non-empty transcription.
const hasSpeech = spawnSync("which", ["espeak-ng"]).status === 0;

describe.skipIf(!fixtureExists)("e2e-multilingual", () => {
  test("transcribes non-English audio with v3 model", async () => {
    const text = await transcribe("fixtures/hello-spanish.wav");
    expect(typeof text).toBe("string");
    if (isModelCached("v3") && hasSpeech) {
      expect(text.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
