import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SECONDS,
  MAX_ALLOWED_SECONDS,
  TRANSCRIBE_TIMEOUT_FLOOR_MS,
  TRANSCRIBE_TIMEOUT_PER_SECOND_MS,
  parseMaxSeconds,
  transcribeTimeoutMs,
} from "../src/lib/dictation-config";

describe("parseMaxSeconds", () => {
  it("uses the default when preference is blank", () => {
    expect(parseMaxSeconds(undefined)).toBe(DEFAULT_MAX_SECONDS);
    expect(parseMaxSeconds("   ")).toBe(DEFAULT_MAX_SECONDS);
  });

  it("accepts an integer inside the allowed range", () => {
    expect(parseMaxSeconds("1")).toBe(1);
    expect(parseMaxSeconds("120")).toBe(120);
    expect(parseMaxSeconds(String(MAX_ALLOWED_SECONDS))).toBe(
      MAX_ALLOWED_SECONDS,
    );
  });

  it("rejects invalid values before starting recording", () => {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "abc",
      String(MAX_ALLOWED_SECONDS + 1),
    ]) {
      expect(() => parseMaxSeconds(value)).toThrow(
        `Max recording seconds must be an integer between 1 and ${MAX_ALLOWED_SECONDS}.`,
      );
    }
  });
});

describe("transcribeTimeoutMs", () => {
  it("gives a short recording only the floor (#944)", () => {
    expect(transcribeTimeoutMs(0)).toBe(TRANSCRIBE_TIMEOUT_FLOOR_MS);
    expect(transcribeTimeoutMs(30)).toBe(
      TRANSCRIBE_TIMEOUT_FLOOR_MS + 30 * TRANSCRIBE_TIMEOUT_PER_SECOND_MS,
    );
  });

  it("scales past the old fixed 60 s cap for a default-length recording (#944)", () => {
    // A 300 s recording at DEFAULTS used to outrun the fixed 60 000 ms cap.
    const scaled = transcribeTimeoutMs(DEFAULT_MAX_SECONDS);
    expect(scaled).toBe(
      TRANSCRIBE_TIMEOUT_FLOOR_MS +
        DEFAULT_MAX_SECONDS * TRANSCRIBE_TIMEOUT_PER_SECOND_MS,
    );
    expect(scaled).toBeGreaterThan(60_000);
  });

  it("rounds fractional recording seconds up and never falls below the floor", () => {
    expect(transcribeTimeoutMs(1.2)).toBe(
      TRANSCRIBE_TIMEOUT_FLOOR_MS + 2 * TRANSCRIBE_TIMEOUT_PER_SECOND_MS,
    );
    expect(transcribeTimeoutMs(-5)).toBe(TRANSCRIBE_TIMEOUT_FLOOR_MS);
    expect(transcribeTimeoutMs(Number.NaN)).toBe(TRANSCRIBE_TIMEOUT_FLOOR_MS);
  });
});
