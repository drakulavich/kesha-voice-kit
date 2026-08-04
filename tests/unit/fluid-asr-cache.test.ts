import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fluidAsrCacheInfo, fluidAsrCachePath } from "../../src/fluid-asr-cache";

describe("fluidAsrCacheInfo", () => {
  // `Repo.folderName` strips the `-coreml` suffix, and a `…-v3-coreml` sibling exists
  // on disk. Reporting that one would call a healthy install broken.
  test("points at the directory FluidAudio loads from, not the -coreml sibling", () => {
    const path = fluidAsrCachePath("/tmp/home");
    expect(path).toBe(
      join("/tmp/home", "Library", "Application Support", "FluidAudio", "Models", "parakeet-tdt-0.6b-v3"),
    );
    expect(path.endsWith("-coreml")).toBe(false);
  });

  const COMPLETE = [
    "Preprocessor.mlmodelc",
    "Decoder.mlmodelc",
    "JointDecisionv3.mlmodelc",
    "parakeet_vocab.json",
    "Encoder.mlmodelc",
  ];

  function seed(homeDir: string, entries: string[]): string {
    const cache = fluidAsrCachePath(homeDir);
    mkdirSync(cache, { recursive: true });
    for (const e of entries) writeFileSync(join(cache, e), "coreml");
    return cache;
  }

  test("reports the bundle on darwin-arm64 when it is complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-test-"));
    try {
      const cache = seed(dir, COMPLETE);

      const info = fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir });

      expect(info.supported).toBe(true);
      expect(info.path).toBe(cache);
      expect(info.exists).toBe(true);
      expect(info.sizeBytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts the int4 encoder in place of int8", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-int4-"));
    try {
      seed(dir, [
        ...COMPLETE.filter((f) => f !== "Encoder.mlmodelc"),
        "EncoderInt4.mlmodelc",
      ]);
      expect(fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir }).exists).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An interrupted fetch leaves the directory present but partial. Calling that
  // healthy lets preflight pass and FluidAudio finish the download mid-transcribe.
  test("reports a partial bundle as absent, not healthy", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-partial-"));
    try {
      seed(dir, ["Encoder.mlmodelc"]);
      expect(fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir }).exists).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports an empty bundle directory as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-bare-"));
    try {
      mkdirSync(fluidAsrCachePath(dir), { recursive: true });
      expect(fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir }).exists).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports absent rather than throwing when the bundle was never fetched", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-empty-"));
    try {
      const info = fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir });
      expect(info.supported).toBe(true);
      expect(info.exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stays inert off darwin-arm64, where the ONNX path is the real one", () => {
    const info = fluidAsrCacheInfo({ platform: "linux", arch: "x64", homeDir: "/tmp/home" });
    expect(info.supported).toBe(false);
    expect(info.exists).toBe(false);
    expect(info.sizeBytes).toBe(0);
  });
});
