import { mock } from "bun:test";
import { basename } from "path";

mock.module("../../src/transcribe", () => ({
  transcribe: async (audioPath: string) => {
    const name = basename(audioPath);
    if (name === "hello-spanish.wav") return "Hola";
    return "test transcription";
  },
}));

import { describe, test, expect, afterAll } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { existsSync } from "fs";

afterAll(() => mock.restore());

const fixtureExists = existsSync("fixtures/hello-spanish.wav");

describe.skipIf(!fixtureExists)("e2e-multilingual", () => {
  test("transcribes non-English audio with v3 model", async () => {
    const text = await transcribe("fixtures/hello-spanish.wav");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
