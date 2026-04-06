import { describe, test, expect } from "bun:test";
import { getModelDir, MODEL_FILES, HF_REPOS } from "../models";
import { join } from "path";
import { homedir } from "os";

describe("models", () => {
  test("getModelDir returns correct cache path for v2", () => {
    const dir = getModelDir("v2");
    expect(dir).toBe(join(homedir(), ".cache", "parakeet", "v2"));
  });

  test("getModelDir returns correct cache path for v3", () => {
    const dir = getModelDir("v3");
    expect(dir).toBe(join(homedir(), ".cache", "parakeet", "v3"));
  });

  test("MODEL_FILES lists required files", () => {
    expect(MODEL_FILES).toContain("encoder-model.onnx");
    expect(MODEL_FILES).toContain("encoder-model.onnx.data");
    expect(MODEL_FILES).toContain("decoder_joint-model.onnx");
    expect(MODEL_FILES).toContain("nemo128.onnx");
    expect(MODEL_FILES).toContain("vocab.txt");
  });

  test("HF_REPOS maps versions to repo IDs", () => {
    expect(HF_REPOS.v2).toBe("istupakov/parakeet-tdt-0.6b-v2-onnx");
    expect(HF_REPOS.v3).toBe("istupakov/parakeet-tdt-0.6b-v3-onnx");
  });
});
