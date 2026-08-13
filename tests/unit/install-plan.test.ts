import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { renderInstallPlan } from "../../src/install-plan";
import { engineVersion } from "../../src/package-info";
import modelPlan from "../../model-plan.json" with { type: "json" };

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
        expect(output).toContain(
          "TTS Kokoro (ANE): staged and hash-verified by `kesha install --tts`",
        );
        // Both staged sets, named where doctor names them (#831).
        expect(output).toContain(join("fluidaudio", "kokoro-82m-coreml", "ANE"));
        expect(output).toContain(join(".cache", "fluidaudio", "Models", "kokoro"));
        expect(output).toContain("outside Kesha's pinned model cache");
        expect(output).toContain("first synthesis compiles, it does not download");
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

  test("--diarize plans the VAD model too (#768)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-diarize-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");

      const output = await renderInstallPlan({ diarize: true });

      expect(output).toContain("VAD Silero v5");
      expect(output).toContain("--diarize installs it to window audio into labelable segments");
      expect(output).toContain("Diarization Sortformer");
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

describe("the plan's download economics", () => {
  function withCache<T>(slug: string, run: (cacheRoot: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), `kesha-install-plan-${slug}-`));
    process.env.HOME = dir;
    process.env.KESHA_CACHE_DIR = join(dir, "cache");
    process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");
    return run(join(dir, "cache")).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  function seed(cacheRoot: string, relPath: string, contents: string) {
    const path = join(cacheRoot, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  const langIdBytes = modelPlan.langId.reduce((sum, f) => sum + f.sizeBytes, 0);
  const status = (plan: string, component: string) =>
    new RegExp(`${component}: [^(]+\\([^,]+, (\\w+),`).exec(plan)?.[1];
  const total = (plan: string, label: string) => new RegExp(`${label}: (.+)`).exec(plan)?.[1];

  // Explicit --coreml/--onnx must beat the probe, or the plan quotes 2.43 GB nobody downloads (#684).
  test("the requested backend decides which ASR component is planned", async () => {
    await withCache("backend", async () => {
      const coreml = await renderInstallPlan({ backend: "coreml" });
      expect(coreml).toContain("ASR Parakeet TDT v3 (CoreML): ~");
      expect(coreml).toContain("FluidAudio cache");
      expect(coreml).not.toMatch(/ASR Parakeet TDT v3: /);

      const onnx = await renderInstallPlan({ backend: "onnx" });
      expect(onnx).toMatch(/ASR Parakeet TDT v3: [^(]+\(\d+ bytes,/);
      expect(onnx).not.toContain("(CoreML)");
      expect(onnx).not.toContain("FluidAudio cache");
    });
  });

  test("a component is cached only once every file is present and non-empty", async () => {
    await withCache("cached", async (cacheRoot) => {
      expect(status(await renderInstallPlan({ backend: "onnx" }), "Audio language ID ECAPA")).toBe(
        "needed",
      );

      for (const file of modelPlan.langId) seed(cacheRoot, file.relPath, "x");
      expect(status(await renderInstallPlan({ backend: "onnx" }), "Audio language ID ECAPA")).toBe(
        "cached",
      );

      const firstLangId = modelPlan.langId[0];
      if (!firstLangId) throw new Error("model-plan.json langId is empty — fixture invariant broken");
      seed(cacheRoot, firstLangId.relPath, "");
      expect(status(await renderInstallPlan({ backend: "onnx" }), "Audio language ID ECAPA")).toBe(
        "needed",
      );
    });
  });

  test("a component quotes the sum of the files it covers", async () => {
    await withCache("sizes", async () => {
      const plan = await renderInstallPlan({ backend: "onnx" });
      expect(plan).toContain(`Audio language ID ECAPA: `);
      expect(plan).toContain(`(${langIdBytes} bytes,`);
    });
  });

  test("the run total drops only for cache hits the run will actually reuse", async () => {
    await withCache("totals", async (cacheRoot) => {
      const cold = "Cold-cache Kesha-managed download";
      const run = "Expected Kesha-managed network for this run";

      const empty = await renderInstallPlan({ backend: "onnx" });
      expect(total(empty, run)).toBe(total(empty, cold));

      for (const file of modelPlan.langId) seed(cacheRoot, file.relPath, "x");
      const warm = await renderInstallPlan({ backend: "onnx" });
      expect(total(warm, cold)).toBe(total(empty, cold));
      expect(total(warm, run)).not.toBe(total(warm, cold));

      // --no-cache re-downloads the hit, so it counts against this run again.
      const refresh = await renderInstallPlan({ backend: "onnx", noCache: true });
      expect(total(refresh, run)).toBe(total(refresh, cold));
    });
  });

  test("a bare plan promises nothing the flags did not ask for", async () => {
    await withCache("bare", async () => {
      const plan = await renderInstallPlan({ backend: "onnx" });
      expect(plan).not.toContain("VAD Silero v5");
      expect(plan).not.toContain("Diarization Sortformer");
      expect(plan).not.toContain("TTS");
      expect(plan).not.toContain("Warm-ups:");
    });
  });

  // FluidAudio fetches its own bundle, so it cannot sit under a "Kesha-managed" total (#684).
  test("a backend-fetched bundle is quoted apart from the managed totals", async () => {
    await withCache("external", async () => {
      const coreml = await renderInstallPlan({ backend: "coreml" });
      const onnx = await renderInstallPlan({ backend: "onnx" });
      const cold = "Cold-cache Kesha-managed download";

      expect(coreml).toContain("Additionally fetched by the backend into its own cache: ~473 MB");
      expect(onnx).not.toContain("Additionally fetched by the backend");
      expect(total(coreml, cold)).not.toBe(total(onnx, cold));
    });
  });
});

describe("install plan with --engine-version (#738)", () => {
  test("an installed pin still reads as needed when the plan names another version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-engine-version-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      const engineDir = join(dir, "engine", "bin");
      const binPath = join(engineDir, "kesha-engine");
      process.env.KESHA_ENGINE_BIN = binPath;
      mkdirSync(engineDir, { recursive: true });
      writeFileSync(binPath, "engine");
      writeFileSync(`${binPath}.version`, `${engineVersion}\n`);

      const pinned = await renderInstallPlan({});
      expect(pinned).toContain(`Engine release: v${engineVersion}`);
      expect(pinned).not.toContain("overrides the pinned");
      expect(pinned).toMatch(/Engine kesha-engine-[^:]+: [^(]+\([^,]+, cached,/);

      const overridden = await renderInstallPlan({ engineVersion: "9.9.9-alpha.1" });
      expect(overridden).toContain(
        `Engine release: v9.9.9-alpha.1 (overrides the pinned v${engineVersion})`,
      );
      expect(overridden).toContain("GitHub release v9.9.9-alpha.1");
      expect(overridden).not.toContain(`GitHub release v${engineVersion}`);
      expect(overridden).toMatch(/Engine kesha-engine-[^:]+: [^(]+\([^,]+, needed,/);
      expect(overridden).toContain("Run: kesha install --engine-version 9.9.9-alpha.1");

      if (process.platform === "darwin" && process.arch === "arm64") {
        // A cold engine fetch re-downloads every sidecar, so present files are not cached work.
        writeFileSync(join(engineDir, "say-avspeech"), "sidecar");
        expect(await renderInstallPlan({})).toMatch(/Sidecar say-avspeech[^:]*: [^(]+\([^,]+, cached,/);
        expect(await renderInstallPlan({ engineVersion: "9.9.9-alpha.1" })).toMatch(
          /Sidecar say-avspeech[^:]*: [^(]+\([^,]+, needed,/,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("install plan carries no platform block (#216)", () => {
  test("the plan never tells a reader the platform is blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-plan-block-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_CACHE_DIR = join(dir, "cache");
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");

      const output = await renderInstallPlan({ ttsLangs: ["en"] });

      expect(output).not.toMatch(/blocked/i);
      expect(output).not.toMatch(/#216/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
