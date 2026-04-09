import { describe, expect, it } from "bun:test";
import { transcribe } from "../../src/lib";

describe("lib API", () => {
  it("rejects missing file", async () => {
    await expect(transcribe("/nonexistent/audio.wav")).rejects.toThrow("File not found");
  });
});
