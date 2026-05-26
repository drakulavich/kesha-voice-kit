import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, utimesSync, rmSync, statSync } from "fs";
import { join } from "path";
import { audioDir, allocAudioPath, sweepOldAudio } from "../../src/mcp/audio-output";

afterEach(() => {
  try { rmSync(audioDir(), { recursive: true, force: true }); } catch {}
});

describe("mcp audio-output", () => {
  test("allocAudioPath returns a unique path with the right extension", () => {
    const a = allocAudioPath("wav");
    const b = allocAudioPath("ogg-opus");
    expect(a.endsWith(".wav")).toBe(true);
    expect(b.endsWith(".ogg")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.startsWith(audioDir())).toBe(true);
  });

  // Unix mode bits don't apply on Windows (ACL-based; mkdirSync mode is a no-op there).
  test.skipIf(process.platform === "win32")("dir is created with 0700", () => {
    allocAudioPath("wav");
    const mode = statSync(audioDir()).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("sweepOldAudio deletes files older than 24h, keeps fresh", () => {
    const dir = audioDir();
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "old.wav");
    const fresh = join(dir, "fresh.wav");
    writeFileSync(old, "x");
    writeFileSync(fresh, "y");
    const longAgo = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(old, longAgo, longAgo);
    sweepOldAudio();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
