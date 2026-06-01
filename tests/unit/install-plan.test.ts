import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { renderInstallPlan } from "../../src/install-plan";

const savedEnv = {
  HOME: process.env.HOME,
  KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
  KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

describe("renderInstallPlan", () => {
  test("describes install economics without mutating local state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");

      const output = await renderInstallPlan({ ttsLangs: ["en", "ru"] });

      expect(output).toContain("Kesha install plan");
      expect(output).toContain("ASR Parakeet TDT v3");
      expect(output).toContain("Audio language ID ECAPA");
      expect(output).toContain("TTS");
      expect(output).toContain("Cold-cache Kesha-managed download:");
      expect(output).toContain("Expected Kesha-managed network for this run:");
      expect(output).toContain("No files are downloaded or changed by --plan.");
      expect(output).toContain("Run: kesha install --tts en ru");
      if (process.platform === "darwin" && process.arch === "arm64") {
        expect(output).toContain("Warm-ups:");
        expect(output).toContain("TTS Kokoro (ANE): FluidAudio CoreML in-engine");
        expect(output).toContain(".cache/fluidaudio/Models/kokoro");
        expect(output).toContain("outside Kesha's pinned model cache");
        expect(output).not.toContain("TTS Kokoro (ANE): 0 B");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--no-cache marks components for refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-refresh-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");

      const output = await renderInstallPlan({ noCache: true, vad: true });

      expect(output).toContain("refresh");
      expect(output).toContain("VAD Silero v5");
      expect(output).toContain("Run: kesha install --no-cache --vad");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--tts plan on non-darwin includes G2P + multilingual voice packs", async () => {
    if (process.platform === "darwin" && process.arch === "arm64") {
      // darwin-arm64 uses FluidAudio Kokoro warmup path, not the ONNX manifest
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-multilang-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");

      const output = await renderInstallPlan({ ttsLangs: ["en", "es", "fr", "it", "pt"] });

      // G2P CharsiuG2P component present in plan
      expect(output).toContain("G2P CharsiuG2P byt5-tiny");
      expect(output).toContain("multilingual G2P for es/fr/it/pt");

      // Kokoro component covers multilingual voices
      expect(output).toContain("TTS Kokoro graph + voices");
      expect(output).toContain("voices for en, es, fr, it, pt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plan with --tts en omits Vosk RU", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-tts-en-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");

      const out = await renderInstallPlan({ ttsLangs: ["en"] });
      expect(out).toContain("Kokoro");
      expect(out).not.toContain("Vosk RU");
      expect(out).toContain("--tts en");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plan with --tts ru omits Kokoro graph component", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-tts-ru-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");

      const out = await renderInstallPlan({ ttsLangs: ["ru"] });
      expect(out).toContain("Vosk RU");
      expect(out).not.toContain("Kokoro");
      expect(out).toContain("--tts ru");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("darwin sidecar cache state follows installed filenames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-sidecar-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      const engineDir = join(dir, "engine", "bin");
      process.env.KESHA_ENGINE_BIN = join(engineDir, "kesha-engine");
      mkdirSync(engineDir, { recursive: true });
      // say-avspeech is staged under its unsuffixed filename (see
      // install-plan sidecarFilename); the plan reports the asset name.
      writeFileSync(join(engineDir, "say-avspeech"), "sidecar");

      const output = await renderInstallPlan({ noCache: true });

      if (process.platform === "darwin" && process.arch === "arm64") {
        expect(output).toContain("Sidecar say-avspeech-darwin-arm64");
        expect(output).toContain("refresh, GitHub release");
      } else {
        expect(output).not.toContain("Sidecar say-avspeech-darwin-arm64");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
