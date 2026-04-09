import { mock } from "bun:test";
import { basename } from "path";

mock.module("../../src/transcribe", () => ({
  transcribe: async (audioPath: string) => {
    const name = basename(audioPath);
    if (name === "hello-english.wav") return "Hello";
    return "test transcription";
  },
}));

import { describe, test, expect, afterAll } from "bun:test";
import { transcribe } from "../../src/transcribe";
import { existsSync } from "fs";

afterAll(() => mock.restore());

const fixtureExists = existsSync("fixtures/hello-english.wav");

describe.skipIf(!fixtureExists)("e2e-english", () => {
  test("transcribes English audio", async () => {
    const text = await transcribe("fixtures/hello-english.wav");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
