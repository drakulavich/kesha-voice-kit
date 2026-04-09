import { describe, test, expect } from "bun:test";
import {
  shouldRetryCoreMLWithWav,
} from "../../src/coreml";

describe("coreml", () => {
  test("retries non-wav files on CoreAudio decode errors", () => {
    expect(
      shouldRetryCoreMLWithWav(
        "fixtures/hello-english.oga",
        new Error("Error: The operation couldn’t be completed. (com.apple.coreaudio.avfaudio error 1718449215.)"),
      ),
    ).toBe(true);
  });

  test("does not retry wav files on CoreAudio decode errors", () => {
    expect(
      shouldRetryCoreMLWithWav(
        "fixtures/silence.wav",
        new Error("Error: The operation couldn’t be completed. (com.apple.coreaudio.avfaudio error 1718449215.)"),
      ),
    ).toBe(false);
  });
});
