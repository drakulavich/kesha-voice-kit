import { describe, test, expect } from "bun:test";
import { getFfmpegInstallHint, assertFfmpegExists, resetFfmpegCheck } from "../../src/audio";

describe("getFfmpegInstallHint", () => {
  test("returns a non-empty string", () => {
    const hint = getFfmpegInstallHint();
    expect(hint).toBeTruthy();
    expect(typeof hint).toBe("string");
  });

  test("contains install keyword", () => {
    const hint = getFfmpegInstallHint();
    expect(hint).toMatch(/install|ffmpeg\.org/i);
  });
});

describe("assertFfmpegExists", () => {
  test("includes install hint when ffmpeg is missing", () => {
    // Save and override Bun.which to simulate missing ffmpeg
    const originalWhich = Bun.which;
    Bun.which = ((cmd: string) => {
      if (cmd === "ffmpeg") return null;
      return originalWhich(cmd);
    }) as typeof Bun.which;

    // Reset the cached check so assertFfmpegExists re-checks
    resetFfmpegCheck();

    try {
      expect(() => assertFfmpegExists()).toThrow(/Install it:/);
    } finally {
      Bun.which = originalWhich;
      resetFfmpegCheck();
    }
  });
});
