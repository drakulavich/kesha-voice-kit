import { describe, expect, test } from "bun:test";
import { extractEngineErrorCode, TS_NATIVE_CODES, KNOWN_TS_CODES } from "../error-codes";

describe("extractEngineErrorCode", () => {
  test("extracts the code from a coded engine stderr line", () => {
    const stderr = "error [E_MODEL_MISSING]: voice 'ru-vosk-m02' not installed. run: kesha install --tts";
    expect(extractEngineErrorCode(stderr)).toBe("E_MODEL_MISSING");
  });

  test("extracts even when the message embeds a path or token", () => {
    const stderr = "warning: foo\nerror [E_BAD_AUDIO]: decode error in: /Users/alice/secret-token-abc.wav";
    expect(extractEngineErrorCode(stderr)).toBe("E_BAD_AUDIO");
  });

  test("returns undefined for an uncoded stderr so caller can fall back", () => {
    expect(extractEngineErrorCode("Error: something went wrong")).toBeUndefined();
  });

  test("TS-native codes are exposed and included in KNOWN_TS_CODES", () => {
    expect(TS_NATIVE_CODES.INPUT_NOT_FOUND).toBe("E_INPUT_NOT_FOUND");
    expect(TS_NATIVE_CODES.ENGINE_SPAWN).toBe("E_ENGINE_SPAWN");
    expect(TS_NATIVE_CODES.INVALID_ARG).toBe("E_INVALID_ARG");
    expect(KNOWN_TS_CODES.has("E_INTERNAL")).toBe(true);
  });
});
