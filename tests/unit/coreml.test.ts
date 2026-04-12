import { describe, test, expect } from "bun:test";
import {
  shouldRetryCoreMLWithWav,
  parseCoreMLLangResult,
} from "../../src/coreml";

describe("coreml", () => {
  test("retries non-wav files on CoreAudio decode errors", () => {
    expect(
      shouldRetryCoreMLWithWav(
        "fixtures/hello-english.oga",
        new Error("Error: The operation couldn't be completed. (com.apple.coreaudio.avfaudio error 1718449215.)"),
      ),
    ).toBe(true);
  });

  test("does not retry wav files on CoreAudio decode errors", () => {
    expect(
      shouldRetryCoreMLWithWav(
        "fixtures/silence.wav",
        new Error("Error: The operation couldn't be completed. (com.apple.coreaudio.avfaudio error 1718449215.)"),
      ),
    ).toBe(false);
  });
});

describe("coreml lang-id helpers", () => {
  test("parseCoreMLLangResult parses valid JSON", () => {
    const validInput = '{"code":"ru","confidence":0.94}';
    expect(parseCoreMLLangResult(validInput)).toEqual({ code: "ru", confidence: 0.94 });
  });
  test("parseCoreMLLangResult returns null for invalid JSON", () => {
    expect(parseCoreMLLangResult("not json")).toBeNull();
  });
  test("parseCoreMLLangResult returns null for empty string", () => {
    expect(parseCoreMLLangResult("")).toBeNull();
  });
  test("parseCoreMLLangResult returns null for missing code field", () => {
    const missingCode = '{"confidence":0.94}';
    expect(parseCoreMLLangResult(missingCode)).toBeNull();
  });
});
