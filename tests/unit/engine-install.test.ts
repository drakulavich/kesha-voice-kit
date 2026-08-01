import { describe, test, expect } from "bun:test";
import {
  buildEngineInstallArgs,
  cleanupRetiredSidecars,
  getVersionMarkerPath,
  getEngineBinaryName,
  readInstalledEngineVersion,
  writeInstalledEngineVersion,
} from "../../src/engine-install";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { defaultEngineBinPath } from "../../src/paths";

function mkTmpBinPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-install-test-"));
  return join(dir, "kesha-engine");
}

describe("engine-install version marker (#151)", () => {
  test("getVersionMarkerPath appends .version alongside binary", () => {
    expect(getVersionMarkerPath("/bin/kesha-engine")).toBe("/bin/kesha-engine.version");
    expect(getVersionMarkerPath("/tmp/foo/x")).toBe("/tmp/foo/x.version");
  });

  test("reads back what was written", () => {
    const binPath = mkTmpBinPath();
    writeInstalledEngineVersion(binPath, "1.2.0");
    expect(readInstalledEngineVersion(binPath)).toBe("1.2.0");
    rmSync(binPath + ".version");
  });

  test("returns null when marker missing", () => {
    const binPath = mkTmpBinPath();
    expect(readInstalledEngineVersion(binPath)).toBeNull();
  });

  test("returns null for empty marker (corrupted file treated as missing)", () => {
    const binPath = mkTmpBinPath();
    writeFileSync(binPath + ".version", "");
    expect(readInstalledEngineVersion(binPath)).toBeNull();
    rmSync(binPath + ".version");
  });

  test("returns null for whitespace-only marker", () => {
    const binPath = mkTmpBinPath();
    writeFileSync(binPath + ".version", "  \n  ");
    expect(readInstalledEngineVersion(binPath)).toBeNull();
    rmSync(binPath + ".version");
  });

  test("trims surrounding whitespace on read (hand-written marker)", () => {
    // Test via writeFileSync so the trim path is actually exercised —
    // writeInstalledEngineVersion only appends one \n, which String.trim
    // would strip regardless of our handling.
    const binPath = mkTmpBinPath();
    writeFileSync(binPath + ".version", "  1.2.0\n\n\n");
    expect(readInstalledEngineVersion(binPath)).toBe("1.2.0");
    rmSync(binPath + ".version");
  });

  test("overwrite replaces previous version", () => {
    const binPath = mkTmpBinPath();
    writeInstalledEngineVersion(binPath, "1.1.3");
    writeInstalledEngineVersion(binPath, "1.2.0");
    expect(readInstalledEngineVersion(binPath)).toBe("1.2.0");
    rmSync(binPath + ".version");
  });
});

describe("buildEngineInstallArgs (#517)", () => {
  test("tts languages become positional args after --tts", () => {
    expect(buildEngineInstallArgs({ noCache: false, ttsLangs: ["en", "ru"] }))
      .toEqual(["install", "--tts", "en", "ru"]);
  });
  test("no tts langs omits --tts", () => {
    expect(buildEngineInstallArgs({ noCache: true, ttsLangs: [] }))
      .toEqual(["install", "--no-cache"]);
  });
});

describe("engine-install retired sidecar cleanup (#438)", () => {
  test("removes old Kokoro and diarize helpers without touching active helpers", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-retired-sidecar-test-"));
    const engineDir = join(dir, "engine", "bin");

    try {
      mkdirSync(engineDir, { recursive: true });
      for (const filename of [
        "kesha-kokoro",
        "kesha-kokoro-darwin-arm64",
        "kesha-diarize",
        "kesha-diarize-darwin-arm64",
        "say-avspeech",
        "say-avspeech-darwin-arm64",
        "kesha-textlang",
        "kesha-textlang-darwin-arm64",
        "kesha-engine",
      ]) {
        writeFileSync(join(engineDir, filename), "binary");
      }

      const removed = cleanupRetiredSidecars(engineDir).sort();

      expect(removed).toEqual([
        "kesha-diarize",
        "kesha-diarize-darwin-arm64",
        "kesha-kokoro",
        "kesha-kokoro-darwin-arm64",
      ]);
      for (const filename of removed) {
        expect(existsSync(join(engineDir, filename))).toBe(false);
      }
      for (const filename of [
        "say-avspeech",
        "say-avspeech-darwin-arm64",
        "kesha-textlang",
        "kesha-textlang-darwin-arm64",
        "kesha-engine",
      ]) {
        expect(existsSync(join(engineDir, filename))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when retired helpers are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-retired-sidecar-empty-test-"));

    try {
      expect(cleanupRetiredSidecars(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getEngineBinaryName platform mapping (#216)", () => {
  test("win32-x64 returns the published Windows asset", () => {
    expect(getEngineBinaryName("win32", "x64")).toBe("kesha-engine-windows-x64.exe");
  });
  test("darwin-arm64 and linux-x64 are unchanged", () => {
    expect(getEngineBinaryName("darwin", "arm64")).toBe("kesha-engine-darwin-arm64");
    expect(getEngineBinaryName("linux", "x64")).toBe("kesha-engine-linux-x64");
  });
  test("no release asset mentions a version workaround", () => {
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["darwin", "arm64"],
      ["linux", "x64"],
    ] as const) {
      expect(getEngineBinaryName(platform, arch)).not.toMatch(/v1\.[45]/);
    }
  });
  test("platforms without a published engine still throw", () => {
    expect(() => getEngineBinaryName("win32", "arm64")).toThrow(/Unsupported platform/);
    expect(() => getEngineBinaryName("darwin", "x64")).toThrow(/Unsupported platform/);
    expect(() => getEngineBinaryName("linux", "arm64")).toThrow(/Unsupported platform/);
  });
});

describe("defaultEngineBinPath extension (#216)", () => {
  test("win32 keeps the .exe suffix so the downloaded PE is spawnable", () => {
    expect(defaultEngineBinPath("win32").endsWith("kesha-engine.exe")).toBe(true);
  });
  test("posix platforms stay extensionless", () => {
    expect(defaultEngineBinPath("linux").endsWith("kesha-engine")).toBe(true);
    expect(defaultEngineBinPath("darwin").endsWith("kesha-engine")).toBe(true);
  });
  test("the version marker follows the binary name on win32", () => {
    expect(getVersionMarkerPath(defaultEngineBinPath("win32"))).toMatch(
      /kesha-engine\.exe\.version$/,
    );
  });
});
