import { describe, test, expect } from "bun:test";
import { formatStatusLine, collectSuggestions, showStatus } from "../../src/status";

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
    const suggestions = collectSuggestions({ onnx: false, coreml: "n/a", ffmpeg: true, platform: "other" });
    expect(suggestions.some((s) => s.includes("parakeet install"))).toBe(true);
  });

  test("suggests ffmpeg install when missing", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "n/a", ffmpeg: false, platform: "other" });
    expect(suggestions.some((s) => s.includes("ffmpeg"))).toBe(true);
  });

  test("returns empty when everything is installed", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "n/a", ffmpeg: true, platform: "other" });
    expect(suggestions).toHaveLength(0);
  });

  test("suggests CoreML install on macOS when missing", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "missing", ffmpeg: true, platform: "mac-arm64" });
    expect(suggestions.some((s) => s.includes("--coreml"))).toBe(true);
  });

  test("suggests model download for binary-only CoreML", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "binary-only", ffmpeg: true, platform: "mac-arm64" });
    expect(suggestions.some((s) => s.includes("download CoreML models"))).toBe(true);
  });

  test("no suggestions for n/a CoreML (non-macOS)", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "n/a", ffmpeg: true, platform: "other" });
    expect(suggestions).toHaveLength(0);
  });

  test("does not suggest ONNX or ffmpeg when CoreML is ready on macOS", () => {
    const suggestions = collectSuggestions({ onnx: false, coreml: "ready", ffmpeg: false, platform: "mac-arm64" });
    expect(suggestions).toHaveLength(0);
  });

  test("suggests refresh when CoreML probe fails", () => {
    const suggestions = collectSuggestions({ onnx: false, coreml: "probe-failed", ffmpeg: false, platform: "mac-arm64" });
    expect(suggestions.some((s) => s.includes("--no-cache"))).toBe(true);
  });
});

describe("showStatus", () => {
  const baseDeps = {
    isMacArm64: () => false,
    getCoreMLBinPath: () => "/mock/bin",
    getCoreMLState: (_binPath: string) => "missing" as const,
    getCoreMLSupportDir: () => "/mock/coreml",
    isModelCached: () => true,
    getModelDir: () => "/mock/onnx",
    whichFfmpeg: () => "/usr/bin/ffmpeg",
    bunVersion: "1.0.0",
    platform: "linux x64",
  };

  test("shows ONNX and ffmpeg status on non-macOS", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await showStatus(baseDeps);
    } finally {
      console.log = origLog;
    }

    const output = lines.join("\n");
    expect(output).toContain("ONNX:");
    expect(output).toContain("/mock/onnx");
    expect(output).toContain("✓");
    expect(output).toContain("ffmpeg");
    expect(output).toContain("Bun 1.0.0");
    expect(output).toContain("linux x64");
    expect(output).not.toContain("CoreML");
  });

  test("shows CoreML section on macOS", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await showStatus({
        ...baseDeps,
        isMacArm64: () => true,
        getCoreMLState: () => "ready" as const,
      });
    } finally {
      console.log = origLog;
    }

    const output = lines.join("\n");
    expect(output).toContain("CoreML (macOS Apple Silicon):");
    expect(output).toContain("Binary");
    expect(output).toContain("Models");
  });

  test("shows warnings for missing components", async () => {
    const warnings: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    console.log = () => {};
    console.error = (msg: string) => warnings.push(msg);
    try {
      await showStatus({
        ...baseDeps,
        isModelCached: () => false,
        whichFfmpeg: () => null,
      });
    } finally {
      console.error = origError;
      console.log = origLog;
    }

    expect(warnings.some((w) => w.includes("parakeet install --onnx"))).toBe(true);
    expect(warnings.some((w) => w.includes("ffmpeg"))).toBe(true);
  });

  test("handles CoreML state probe failure gracefully", async () => {
    const lines: string[] = [];
    const warnings: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (msg: string) => lines.push(msg);
    console.error = (msg: string) => warnings.push(msg);
    try {
      await showStatus({
        ...baseDeps,
        isMacArm64: () => true,
        getCoreMLState: () => { throw new Error("probe failed"); return "missing" as never; },
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    const output = lines.join("\n");
    expect(output).toContain("CoreML");
    expect(output).toContain("probe failed");
    expect(warnings.some((warning) => warning.includes("CoreML status probe failed"))).toBe(true);
  });
});
