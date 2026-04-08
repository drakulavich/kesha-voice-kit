import { describe, test, expect } from "bun:test";
import { getModelDir, MODEL_FILES, HF_REPO } from "../onnx-install";
import { join } from "path";
import { homedir } from "os";

describe("models", () => {
  test("getModelDir returns correct cache path", () => {
    const dir = getModelDir();
    expect(dir).toBe(join(homedir(), ".cache", "parakeet", "v3"));
  });

  test("MODEL_FILES lists required files", () => {
    expect(MODEL_FILES).toContain("encoder-model.onnx");
    expect(MODEL_FILES).toContain("encoder-model.onnx.data");
    expect(MODEL_FILES).toContain("decoder_joint-model.onnx");
    expect(MODEL_FILES).toContain("nemo128.onnx");
    expect(MODEL_FILES).toContain("vocab.txt");
  });

  test("HF_REPO points to v3 ONNX repo", () => {
    expect(HF_REPO).toBe("istupakov/parakeet-tdt-0.6b-v3-onnx");
  });
});
