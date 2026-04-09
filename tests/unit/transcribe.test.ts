import { mock, describe, test, expect, beforeEach, afterAll } from "bun:test";

// Only mock the routing dependencies — not audio or ONNX pipeline
// to avoid mock bleed into integration tests
mock.module("../../src/coreml", () => ({
  isCoreMLInstalled: () => mockState.coremlInstalled,
  transcribeCoreML: async () => "coreml result",
  isMacArm64: () => mockState.macArm64,
}));

mock.module("../../src/onnx-install", () => ({
  isModelCached: () => mockState.onnxCached,
  requireModel: () => "/mock/model",
  installHintError: (msg: string) => new Error(msg),
}));

import { transcribe } from "../../src/transcribe";

const mockState = {
  coremlInstalled: false,
  macArm64: false,
  onnxCached: false,
};

afterAll(() => mock.restore());

beforeEach(() => {
  mockState.coremlInstalled = false;
  mockState.macArm64 = false;
  mockState.onnxCached = false;
});

describe("transcribe routing", () => {
  test("uses CoreML when installed", async () => {
    mockState.coremlInstalled = true;
    const result = await transcribe("test.wav");
    expect(result).toBe("coreml result");
  });

  test("throws install hint when no backend is available", async () => {
    mockState.coremlInstalled = false;
    mockState.onnxCached = false;
    await expect(transcribe("test.wav")).rejects.toThrow("No transcription backend is installed");
  });

  test("warns about CoreML fallback on macOS ARM64 when not silent", async () => {
    mockState.macArm64 = true;
    mockState.onnxCached = false;

    const warnings: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => warnings.push(msg);
    try {
      await expect(transcribe("test.wav")).rejects.toThrow();
    } finally {
      console.error = origError;
    }

    expect(warnings.some((w) => w.includes("CoreML backend unavailable"))).toBe(true);
  });

  test("no CoreML fallback warning when silent", async () => {
    mockState.macArm64 = true;
    mockState.onnxCached = false;

    const warnings: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => warnings.push(msg);
    try {
      await expect(transcribe("test.wav", { silent: true })).rejects.toThrow();
    } finally {
      console.error = origError;
    }

    expect(warnings.some((w) => w.includes("CoreML backend unavailable"))).toBe(false);
  });

  test("no CoreML fallback warning on non-macOS", async () => {
    mockState.macArm64 = false;
    mockState.onnxCached = false;

    const warnings: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => warnings.push(msg);
    try {
      await expect(transcribe("test.wav")).rejects.toThrow();
    } finally {
      console.error = origError;
    }

    expect(warnings.some((w) => w.includes("CoreML backend unavailable"))).toBe(false);
  });
});
