import { describe, expect, it } from "bun:test";
import { transcribe } from "../../src/lib";

describe("lib API", () => {
  it("rejects missing file", async () => {
    await expect(transcribe("/nonexistent/audio.wav")).rejects.toThrow("File not found");
  });

  it("exports say()", async () => {
    const { say } = await import("../../src/lib");
    expect(typeof say).toBe("function");
  });

  it("exports downloadTts()", async () => {
    const { downloadTts } = await import("../../src/lib");
    expect(typeof downloadTts).toBe("function");
  });

  it("exports SayError class with code + stderr fields", async () => {
    const { SayError } = await import("../../src/lib");
    const e = new SayError("msg", 1, "stderr");
    expect(e.exitCode).toBe(1);
    expect(e.stderr).toBe("stderr");
  });
});
