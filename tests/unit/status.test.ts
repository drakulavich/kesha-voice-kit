import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { formatStatusLine, activeModelMirror, showStatus } from "../../src/status";
import { starSeenPath } from "../../src/star";

const posixEngineTest = process.platform === "win32" ? test.skip : test;

describe("formatStatusLine", () => {
  test("formats installed component", () => {
    const line = formatStatusLine("Binary", "/path/to/bin", true);
    expect(line).toContain("Binary");
    expect(line).toContain("/path/to/bin");
    expect(line).toContain("✓");
    expect(line).not.toContain("✗");
  });

  test("formats missing component", () => {
    const line = formatStatusLine("Binary", null, false);
    expect(line).toContain("Binary");
    expect(line).toContain("✗");
    expect(line).toContain("not installed");
  });

  test("formats missing component with custom label", () => {
    const line = formatStatusLine("ffmpeg", null, false, "not found");
    expect(line).toContain("not found");
  });

  test("keeps status before long values instead of padding to a fragile column", () => {
    const longPath = `/very/long/${"nested/".repeat(20)}kesha-engine`;
    const line = formatStatusLine("Binary", longPath, true);
    expect(line.indexOf("✓")).toBeLessThan(line.indexOf("Binary"));
    expect(line).toContain(`Binary: ${longPath}`);
    expect(line).not.toMatch(/ {8,}✓/);
  });
});

describe("activeModelMirror (#121)", () => {
  const saved = process.env.KESHA_MODEL_MIRROR;

  beforeEach(() => {
    delete process.env.KESHA_MODEL_MIRROR;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.KESHA_MODEL_MIRROR;
    else process.env.KESHA_MODEL_MIRROR = saved;
  });

  test("null when unset", () => {
    expect(activeModelMirror()).toBeNull();
  });

  test("null when empty", () => {
    process.env.KESHA_MODEL_MIRROR = "";
    expect(activeModelMirror()).toBeNull();
  });

  test("null when whitespace-only", () => {
    process.env.KESHA_MODEL_MIRROR = "   ";
    expect(activeModelMirror()).toBeNull();
  });

  test("returns the URL when set", () => {
    process.env.KESHA_MODEL_MIRROR = "https://mirror.example.com/kesha";
    expect(activeModelMirror()).toBe("https://mirror.example.com/kesha");
  });

  test("strips trailing slashes to match the Rust side", () => {
    process.env.KESHA_MODEL_MIRROR = "https://mirror.example.com/kesha///";
    expect(activeModelMirror()).toBe("https://mirror.example.com/kesha");
  });
});

describe("showStatus", () => {
  const savedEngineBin = process.env.KESHA_ENGINE_BIN;
  const savedCacheDir = process.env.KESHA_CACHE_DIR;
  const savedHome = process.env.HOME;
  const savedMirror = process.env.KESHA_MODEL_MIRROR;

  function restoreEnv() {
    if (savedEngineBin === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = savedEngineBin;
    if (savedCacheDir === undefined) delete process.env.KESHA_CACHE_DIR;
    else process.env.KESHA_CACHE_DIR = savedCacheDir;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedMirror === undefined) delete process.env.KESHA_MODEL_MIRROR;
    else process.env.KESHA_MODEL_MIRROR = savedMirror;
  }

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  test("does not consume the star prompt marker slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-test-"));
    const binDir = join(dir, "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFileSync(binPath, "not a real executable");

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = dir;
    process.env.HOME = dir;

    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await showStatus();
      expect(existsSync(starSeenPath(binPath))).toBe(false);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not scan or print disk usage unless requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-test-"));
    const binDir = join(dir, "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFileSync(binPath, "not a real executable");
    mkdirSync(join(dir, "models", "parakeet-tdt-v3"), { recursive: true });
    writeFileSync(join(dir, "models", "parakeet-tdt-v3", "model.onnx"), "model");
    mkdirSync(join(dir, ".cache", "fluidaudio", "Models", "kokoro", "kokoro_21_15s.mlmodelc"), {
      recursive: true,
    });
    writeFileSync(
      join(
        dir,
        ".cache",
        "fluidaudio",
        "Models",
        "kokoro",
        "kokoro_21_15s.mlmodelc",
        "coremldata.bin",
      ),
      "coreml",
    );

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = dir;
    process.env.HOME = dir;

    const originalLog = console.log;
    const originalError = console.error;
    const lines: string[] = [];
    console.log = (msg: string) => {
      lines.push(msg);
    };
    console.error = () => {};
    try {
      await showStatus();
      expect(lines.join("\n")).not.toContain("Disk usage");

      lines.length = 0;
      await showStatus({ disk: true });
      expect(lines.join("\n")).toContain("Disk usage");
      if (process.platform === "darwin" && process.arch === "arm64") {
        expect(lines.join("\n")).toContain("External caches (not included in Kesha total):");
        expect(lines.join("\n")).toContain("FluidAudio Kokoro:");
        expect(lines.join("\n")).toContain(".cache/fluidaudio/Models/kokoro");
      } else {
        expect(lines.join("\n")).not.toContain("FluidAudio Kokoro:");
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("prints engine capabilities, mirror, and installed voices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-installed-test-"));
    const cache = join(dir, ".cache", "kesha");
    const binDir = join(cache, "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFileSync(
      binPath,
      `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '{"protocolVersion":2,"backend":"fake-coreml","features":["transcribe.segments","transcribe.diarize"]}'
  exit 0
fi
exit 2
`,
    );
    chmodSync(binPath, 0o755);
    mkdirSync(join(cache, "models", "kokoro-82m", "voices"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voices", "am_michael.bin"), "voice");
    writeFileSync(join(cache, "models", "kokoro-82m", "voices", "README.txt"), "ignored");
    mkdirSync(join(cache, "models", "vosk-ru", "bert"), { recursive: true });
    writeFileSync(join(cache, "models", "vosk-ru", "model.onnx"), "model");
    writeFileSync(join(cache, "models", "vosk-ru", "bert", "model.onnx"), "bert");

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    process.env.KESHA_MODEL_MIRROR = "https://mirror.example.com/kesha///";

    const originalLog = console.log;
    const originalError = console.error;
    const lines: string[] = [];
    console.log = (msg: string) => {
      lines.push(msg);
    };
    console.error = () => {};
    try {
      await showStatus();
      const output = lines.join("\n");
      expect(output).toContain("Backend: fake-coreml");
      expect(output).toContain("Protocol: v2");
      expect(output).toContain("Features: transcribe.segments, transcribe.diarize");
      expect(output).toContain("Mirror: https://mirror.example.com/kesha");
      expect(output).toContain("TTS voices:");
      expect(output).toContain("en-am_michael");
      expect(output).toContain("ru-vosk-m02");
      expect(output).not.toContain("README");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
