import { describe, test, expect } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import {
  LANG_ID_HF_REPO,
  LANG_ID_ONNX_FILES,
  LANG_ID_COREML_FILES,
  getLangIdOnnxDir,
  getLangIdCoreMLDir,
  isLangIdOnnxCached,
  isLangIdCoreMLCached,
} from "../../src/lang-id-install";

describe("lang-id-install constants", () => {
  test("LANG_ID_HF_REPO is the correct HuggingFace repo", () => {
    expect(LANG_ID_HF_REPO).toBe("drakulavich/parakeet-lang-id-ecapa");
  });

  test("LANG_ID_ONNX_FILES contains expected files", () => {
    expect(LANG_ID_ONNX_FILES).toContain("lang-id-ecapa.onnx");
    expect(LANG_ID_ONNX_FILES).toContain("labels.json");
  });

  test("LANG_ID_COREML_FILES contains expected files", () => {
    expect(LANG_ID_COREML_FILES).toContain("lang-id-ecapa.mlpackage");
    expect(LANG_ID_COREML_FILES).toContain("labels.json");
  });
});

describe("lang-id-install path functions", () => {
  test("getLangIdOnnxDir returns correct path under ~/.cache/parakeet", () => {
    expect(getLangIdOnnxDir()).toBe(
      join(homedir(), ".cache", "parakeet", "lang-id", "onnx"),
    );
  });

  test("getLangIdCoreMLDir returns correct path under ~/.cache/parakeet", () => {
    expect(getLangIdCoreMLDir()).toBe(
      join(homedir(), ".cache", "parakeet", "lang-id", "coreml"),
    );
  });

  test("ONNX and CoreML dirs are distinct paths", () => {
    expect(getLangIdOnnxDir()).not.toBe(getLangIdCoreMLDir());
  });
});

describe("lang-id-install cache checks", () => {
  test("isLangIdOnnxCached returns false for nonexistent directory", () => {
    expect(isLangIdOnnxCached("/nonexistent/path/that/does/not/exist")).toBe(false);
  });

  test("isLangIdCoreMLCached returns false for nonexistent directory", () => {
    expect(isLangIdCoreMLCached("/nonexistent/path/that/does/not/exist")).toBe(false);
  });

  test("isLangIdOnnxCached uses default dir when no arg provided", () => {
    // Should not throw, just return a boolean
    const result = isLangIdOnnxCached();
    expect(typeof result).toBe("boolean");
  });

  test("isLangIdCoreMLCached uses default dir when no arg provided", () => {
    // Should not throw, just return a boolean
    const result = isLangIdCoreMLCached();
    expect(typeof result).toBe("boolean");
  });
});
