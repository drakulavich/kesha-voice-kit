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

  // Both spellings must count: `G2PEncoder` is what `kesha install --tts`
  // stages today, `kokoro_21_15s` is what a pre-0.15.5 install left behind, and
  // reporting either as "no cache here" would send the user to reinstall.
  test.each(["G2PEncoder.mlmodelc", "kokoro_21_15s.mlmodelc"])(
    "detects %s on darwin-arm64",
    (bundle) => {
      const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-kokoro-cache-test-"));
      try {
        const cache = fluidKokoroCachePath(dir);
        const body = "coreml";
        mkdirSync(join(cache, bundle), { recursive: true });
        writeFileSync(join(cache, bundle, "coremldata.bin"), body);

        const info = fluidKokoroCacheInfo({
          platform: "darwin",
          arch: "arm64",
          homeDir: dir,
        });

        expect(info.supported).toBe(true);
        expect(info.path).toBe(cache);
        expect(info.exists).toBe(true);
        expect(info.sizeBytes).toBe(body.length);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
