import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { formatStatusLine, activeModelMirror } from "../../src/status";

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

describe("activeModelMirror (#121)", () => {
  const saved = process.env.KESHA_MODEL_MIRROR;

  beforeEach(() => {
    delete process.env.KESHA_MODEL_MIRROR;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.KESHA_MODEL_MIRROR;
    else process.env.KESHA_MODEL_MIRROR = saved;
  });

  test("null when unset", () => {
    expect(activeModelMirror()).toBeNull();
  });

  test("null when empty", () => {
    process.env.KESHA_MODEL_MIRROR = "";
    expect(activeModelMirror()).toBeNull();
  });

  test("null when whitespace-only", () => {
    process.env.KESHA_MODEL_MIRROR = "   ";
    expect(activeModelMirror()).toBeNull();
  });

  test("returns the URL when set", () => {
    process.env.KESHA_MODEL_MIRROR = "https://mirror.example.com/kesha";
    expect(activeModelMirror()).toBe("https://mirror.example.com/kesha");
  });

  test("strips trailing slashes to match the Rust side", () => {
    process.env.KESHA_MODEL_MIRROR = "https://mirror.example.com/kesha///";
    expect(activeModelMirror()).toBe("https://mirror.example.com/kesha");
  });
});
