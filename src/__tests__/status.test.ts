import { describe, test, expect } from "bun:test";
import { formatStatusLine, collectSuggestions } from "../status";

describe("formatStatusLine", () => {
  test("formats installed component", () => {
    const line = formatStatusLine("Binary", "/path/to/bin", true);
    expect(line).toContain("Binary");
    expect(line).toContain("/path/to/bin");
    expect(line).toContain("✓");
    expect(line).not.toContain("✗");
  });

  test("formats missing component", () => {
    const line = formatStatusLine("Binary", null, false);
    expect(line).toContain("Binary");
    expect(line).toContain("✗");
    expect(line).toContain("not installed");
  });

  test("formats missing component with custom label", () => {
    const line = formatStatusLine("ffmpeg", null, false, "not found");
    expect(line).toContain("not found");
  });
});

describe("collectSuggestions", () => {
  test("suggests install for missing ONNX", () => {
    const suggestions = collectSuggestions({ onnx: false, coreml: "missing", ffmpeg: true });
    expect(suggestions.some((s) => s.includes("parakeet install"))).toBe(true);
  });

  test("suggests ffmpeg install when missing", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "ready", ffmpeg: false });
    expect(suggestions.some((s) => s.includes("ffmpeg"))).toBe(true);
  });

  test("returns empty when everything is installed", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "ready", ffmpeg: true });
    expect(suggestions).toHaveLength(0);
  });

  test("suggests CoreML install on macOS when missing", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "missing", ffmpeg: true });
    expect(suggestions.some((s) => s.includes("--coreml"))).toBe(true);
  });
});
