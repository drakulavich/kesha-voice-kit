import { describe, expect, it } from "bun:test";
import { transcribe } from "../lib";

describe("lib API", () => {
  it("exports transcribe function", () => {
    expect(typeof transcribe).toBe("function");
  });

  it("rejects missing file", async () => {
    await expect(transcribe("/nonexistent/audio.wav")).rejects.toThrow("File not found");
  });
});
