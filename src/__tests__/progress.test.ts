import { describe, test, expect } from "bun:test";
import { formatProgressBar, formatBytes } from "../progress";

describe("formatBytes", () => {
  test("formats bytes to MB", () => {
    expect(formatBytes(104857600)).toBe("100.0MB");
  });

  test("formats small values", () => {
    expect(formatBytes(1048576)).toBe("1.0MB");
  });

  test("formats zero", () => {
    expect(formatBytes(0)).toBe("0.0MB");
  });
});

describe("formatProgressBar", () => {
  test("renders 0%", () => {
    const bar = formatProgressBar("encoder.onnx", 0, 100);
    expect(bar).toContain("encoder.onnx");
    expect(bar).toContain("0%");
    expect(bar).toContain("░");
  });

  test("renders 50%", () => {
    const bar = formatProgressBar("encoder.onnx", 50, 100);
    expect(bar).toContain("50%");
    expect(bar).toContain("█");
  });

  test("renders 100%", () => {
    const bar = formatProgressBar("encoder.onnx", 100, 100);
    expect(bar).toContain("100%");
  });

  test("includes byte counts in MB", () => {
    const bar = formatProgressBar("file.onnx", 104857600, 209715200);
    expect(bar).toContain("100.0MB");
    expect(bar).toContain("200.0MB");
  });
});
