import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  fluidKokoroCacheInfo,
  fluidKokoroCachePath,
  isDarwinArm64,
} from "../../src/fluid-kokoro-cache";

describe("fluidKokoroCacheInfo", () => {
  test("uses the FluidAudio Kokoro cache under HOME", () => {
    expect(fluidKokoroCachePath("/tmp/home")).toBe(
      join("/tmp/home", ".cache", "fluidaudio", "Models", "kokoro"),
    );
  });

  test("detects CoreML Kokoro bundles on darwin-arm64", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-kokoro-cache-test-"));
    try {
      const cache = fluidKokoroCachePath(dir);
      mkdirSync(join(cache, "kokoro_21_15s.mlmodelc"), { recursive: true });
      writeFileSync(join(cache, "kokoro_21_15s.mlmodelc", "coremldata.bin"), "coreml");

      const info = fluidKokoroCacheInfo({
        platform: "darwin",
        arch: "arm64",
        homeDir: dir,
      });

      expect(info.supported).toBe(true);
      expect(info.path).toBe(cache);
      expect(info.exists).toBe(true);
      expect(info.sizeBytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not advertise FluidAudio Kokoro on non-darwin-arm64", () => {
    const info = fluidKokoroCacheInfo({
      platform: "linux",
      arch: "x64",
      homeDir: "/tmp/home",
    });

    expect(isDarwinArm64("linux", "x64")).toBe(false);
    expect(info.supported).toBe(false);
    expect(info.exists).toBe(false);
    expect(info.sizeBytes).toBe(0);
  });
});
