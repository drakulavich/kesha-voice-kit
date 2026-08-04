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

  test("reports the bundle on darwin-arm64 when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-test-"));
    try {
      const cache = fluidAsrCachePath(dir);
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, "Encoder.mlmodelc"), "coreml");

      const info = fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir });

      expect(info.supported).toBe(true);
      expect(info.path).toBe(cache);
      expect(info.exists).toBe(true);
      expect(info.sizeBytes).toBeGreaterThan(0);
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
