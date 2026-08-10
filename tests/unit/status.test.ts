import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { join, sep } from "path";
import { tmpdir } from "os";
import {
  formatStatusLine,
  activeModelMirror,
  collectStatus,
  renderStatus,
  type StatusDiskUsage,
  type StatusReport,
} from "../../src/status";
import { humanBytes } from "../../src/format";
import { starSeenPath } from "../../src/star";
import { saveEngineEnv, writeFakeEngine } from "../helpers/fake-engine";

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

describe("collectStatus + renderStatus", () => {
  const restoreEnv = saveEngineEnv();

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
      renderStatus(await collectStatus());
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
      renderStatus(await collectStatus());
      expect(lines.join("\n")).not.toContain("Disk usage");

      lines.length = 0;
      renderStatus(await collectStatus({ disk: true }));
      expect(lines.join("\n")).toContain("Disk usage");
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
      renderStatus(await collectStatus());
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

describe("collectStatus --json payload (#647)", () => {
  const restoreEnv = saveEngineEnv();

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  function healthyEngine(): { dir: string; cache: string; binPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"));
    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    return { dir, cache, binPath };
  }

  posixEngineTest("engine installed: presence, path, capabilities, voices", async () => {
    const { dir, cache, binPath } = healthyEngine();
    mkdirSync(join(cache, "models", "kokoro-82m", "voices"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voices", "am_michael.bin"), "voice");
    try {
      const report = await collectStatus();
      expect(report.engine.installed).toBe(true);
      expect(report.engine.path).toBe(binPath);
      expect(report.engine.capabilities).toEqual({
        protocolVersion: 3,
        backend: "fake-coreml",
        features: ["tts"],
      });
      expect(report.voices).toEqual(["en-am_michael"]);
      expect(report.hint).toBeNull();
      expect(report.disk).toBeNull();
      expect(report.cliVersion).toBeString();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("engine absent: presence false, hint carried in the payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-missing-"));
    process.env.KESHA_ENGINE_BIN = join(dir, "nope", "kesha-engine");
    process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
    process.env.HOME = dir;
    try {
      const report = await collectStatus();
      expect(report.engine.installed).toBe(false);
      expect(report.engine.capabilities).toBeNull();
      expect(report.hint).toContain("kesha ins");
      expect(report.voices).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #801: `installed: true` with `capabilities: null` used to carry no hint at all, so
  // status read clean for an engine that could not answer a single question.
  posixEngineTest("binary present but capabilities unreadable: installed, caps null, hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-broken-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"), null);
    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const report = await collectStatus();
      expect(report.engine.installed).toBe(true);
      expect(report.engine.capabilities).toBeNull();
      expect(report.hint).toContain("not functional (reports no capabilities)");
      expect(report.hint).toContain("kesha install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("an engine that exits 0 and says nothing is not a clean bill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-mute-"));
    const cache = join(dir, ".cache", "kesha");
    const binDir = join(cache, "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const report = await collectStatus();
      expect(report.engine.installed).toBe(true);
      expect(report.engine.capabilities).toBeNull();
      expect(report.hint).toContain("not functional (reports no capabilities)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("capabilities of the wrong shape are rejected, not forwarded", async () => {
    // Non-null capabilities must mean it described itself: `renderStatus` calls `features.join` (#647).
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-shape-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"), {
      protocolVersion: "three",
      backend: 42,
    });
    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const report = await collectStatus();
      expect(report.engine.installed).toBe(true);
      expect(report.engine.capabilities).toBeNull();
      expect(() => renderStatus(report)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--disk with no engine reports null without walking the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-nodisk-"));
    const cache = join(dir, ".cache", "kesha");
    mkdirSync(join(cache, "models", "parakeet-tdt-v3"), { recursive: true });
    writeFileSync(join(cache, "models", "parakeet-tdt-v3", "model.onnx"), "model");
    process.env.KESHA_ENGINE_BIN = join(dir, "nope", "kesha-engine");
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const report = await collectStatus({ disk: true });
      expect(report.engine.installed).toBe(false);
      expect(report.disk).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("--disk toggles the disk section", async () => {
    const { dir, cache } = healthyEngine();
    mkdirSync(join(cache, "models", "parakeet-tdt-v3"), { recursive: true });
    writeFileSync(join(cache, "models", "parakeet-tdt-v3", "model.onnx"), "model");
    try {
      expect((await collectStatus()).disk).toBeNull();
      const withDisk = await collectStatus({ disk: true });
      expect(withDisk.disk).not.toBeNull();
      expect(withDisk.disk!.components.length).toBeGreaterThan(0);
      expect(withDisk.disk!.totalBytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every documented key is present, never omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-keys-"));
    process.env.KESHA_ENGINE_BIN = join(dir, "nope", "kesha-engine");
    process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
    process.env.HOME = dir;
    try {
      const report = await collectStatus();
      const roundTripped = JSON.parse(JSON.stringify(report));
      expect(Object.keys(roundTripped).sort()).toEqual([
        "cliVersion",
        "disk",
        "engine",
        "hint",
        "modelMirror",
        "runtime",
        "voices",
      ]);
      expect(Object.keys(roundTripped.engine).sort()).toEqual([
        "capabilities",
        "installed",
        "path",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderStatus turns a report into the states a user acts on", () => {
  function report(overrides: Partial<StatusReport> = {}): StatusReport {
    return {
      cliVersion: "9.9.9",
      engine: { installed: true, path: "/cache/engine/bin/kesha-engine", capabilities: null },
      voices: [],
      runtime: { bun: "1.9.9", platform: "testos", arch: "testarch" },
      modelMirror: null,
      hint: null,
      disk: null,
      ...overrides,
    };
  }

  function render(r: StatusReport): string {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (msg: string) => {
      lines.push(msg);
    };
    try {
      renderStatus(r);
    } finally {
      console.log = originalLog;
    }
    return lines.join("\n").replace(/\u001b\[\d+m/g, "");
  }

  test("an engine that cannot describe itself is a failed probe, not a missing one", () => {
    const output = render(report({ engine: { installed: true, path: "/bin/e", capabilities: null } }));
    expect(output).toContain("✗ Capabilities: probe failed");
    expect(output).not.toContain("Backend");
  });

  test("a described engine reports its backend, protocol and features", () => {
    const output = render(
      report({
        engine: {
          installed: true,
          path: "/bin/e",
          capabilities: { protocolVersion: 4, backend: "onnx", features: ["tts", "diarize"] },
        },
      }),
    );
    expect(output).toContain("✓ Backend: onnx");
    expect(output).toContain("✓ Protocol: v4");
    expect(output).toContain("✓ Features: tts, diarize");
    expect(output).not.toContain("probe failed");
  });

  test("nothing engine-shaped is reported when the engine is absent", () => {
    const output = render(
      report({
        engine: {
          installed: false,
          path: "/bin/e",
          capabilities: { protocolVersion: 4, backend: "onnx", features: ["tts"] },
        },
        voices: ["en-am_michael"],
        disk: diskUsage(),
      }),
    );
    expect(output).toContain("✗ Binary: not installed");
    expect(output).not.toContain("Backend");
    expect(output).not.toContain("TTS voices");
    expect(output).not.toContain("Disk usage");
  });

  test("runtime and platform are reported as present, never as not installed", () => {
    const output = render(report());
    expect(output).toContain("Runtime: Bun 1.9.9");
    expect(output).toContain("Platform: testos testarch");
    expect(output).not.toContain("Runtime: not installed");
    expect(output).not.toContain("Platform: not installed");
  });

  test("the mirror line appears only when a mirror is configured", () => {
    expect(render(report({ modelMirror: "https://mirror.example.com" }))).toContain(
      "Mirror: https://mirror.example.com",
    );
    expect(render(report())).not.toContain("Mirror");
  });

  test("the voices section is dropped rather than shown empty", () => {
    expect(render(report({ voices: [] }))).not.toContain("TTS voices");
    const listed = render(report({ voices: ["en-am_michael", "ru-vosk-m02"] }));
    expect(listed).toContain("TTS voices:");
    expect(listed).toContain("en-am_michael");
    expect(listed).toContain("ru-vosk-m02");
  });

  function diskUsage(overrides: Partial<StatusDiskUsage> = {}): StatusDiskUsage {
    return {
      cachePath: "/cache",
      components: [
        { label: "Engine", sizeBytes: 4_000 },
        { label: "TTS (Kokoro)", sizeBytes: 6_000 },
      ],
      componentTotalBytes: 10_000,
      totalBytes: 10_000,
      externalRoots: [],
      externalTotalBytes: 0,
      grandTotalBytes: 10_000,
      ...overrides,
    };
  }

  const fluidRoot = "/home/Library/Application Support/FluidAudio";
  const asrDir = `${fluidRoot}/Models/parakeet-tdt-0.6b-v3`;

  test("each component is listed with its own size", () => {
    const output = render(report({ disk: diskUsage() }));
    expect(output).toContain(`Engine:`);
    expect(output).toContain(humanBytes(4_000));
    expect(output).toContain(`TTS (Kokoro):`);
    expect(output).toContain(humanBytes(6_000));
  });

  test("cache bytes outside the listed components are called out, and only then", () => {
    const surplus = render(report({ disk: diskUsage({ totalBytes: 25_000 }) }));
    expect(surplus).toContain(humanBytes(25_000));
    expect(surplus).toContain(`includes ${humanBytes(15_000)} of other cache files`);

    const exact = render(report({ disk: diskUsage() }));
    expect(exact).not.toContain("other cache files");
  });

  test("a FluidAudio root outside the cache is named, sized and folded into a grand total", () => {
    const output = render(
      report({
        disk: diskUsage({
          externalRoots: [
            {
              path: fluidRoot,
              sizeBytes: 3_000_000,
              subsystems: [{ label: "ASR (Parakeet)", path: asrDir, sizeBytes: 2_000_000 }],
              otherBytes: 1_000_000,
            },
          ],
          externalTotalBytes: 3_000_000,
          grandTotalBytes: 3_010_000,
        }),
      }),
    );
    expect(output).toContain(fluidRoot);
    expect(output).toContain(humanBytes(3_000_000));
    expect(output).toContain("ASR (Parakeet)");
    expect(output).toContain(humanBytes(2_000_000));
    expect(output).toContain(humanBytes(1_000_000));
    expect(output).toContain(humanBytes(3_010_000));

    expect(render(report({ disk: diskUsage() }))).not.toContain("FluidAudio");
  });

  test("a root with nothing left to attribute says so rather than naming a subsystem", () => {
    const output = render(
      report({
        disk: diskUsage({
          externalRoots: [
            { path: fluidRoot, sizeBytes: 900_000, subsystems: [], otherBytes: 900_000 },
          ],
          externalTotalBytes: 900_000,
          grandTotalBytes: 910_000,
        }),
      }),
    );
    expect(output).toContain("not attributed to any subsystem above");
    expect(output).not.toContain("ASR (Parakeet)");
  });

  test("a cache with nothing in it prints no disk section", () => {
    expect(render(report({ disk: diskUsage({ components: [] }) }))).not.toContain("Disk usage");
  });

  test("an empty cache still reports a FluidAudio root that holds bytes", () => {
    const output = render(
      report({
        disk: diskUsage({
          components: [],
          componentTotalBytes: 0,
          totalBytes: 0,
          externalRoots: [
            { path: fluidRoot, sizeBytes: 900_000, subsystems: [], otherBytes: 900_000 },
          ],
          externalTotalBytes: 900_000,
          grandTotalBytes: 900_000,
        }),
      }),
    );
    expect(output).toContain(fluidRoot);
  });

  test("the reset hint names the directory to remove", () => {
    const output = render(report({ disk: diskUsage({ cachePath: "/somewhere/kesha" }) }));
    expect(output).toContain("rm -rf /somewhere/kesha");
  });
});

describe("collectStatus disk accounting (#647)", () => {
  const restoreEnv = saveEngineEnv();

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  posixEngineTest("empty component directories are dropped and the rest are summed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-disk-sum-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"));
    mkdirSync(join(cache, "engine", "lib"), { recursive: true });
    writeFileSync(join(cache, "engine", "lib", "sidecar.dylib"), "x".repeat(32));
    mkdirSync(join(cache, "models", "kokoro-82m"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voice.bin"), "x".repeat(64));
    mkdirSync(join(cache, "models", "vosk-ru"), { recursive: true });

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const disk = (await collectStatus({ disk: true })).disk!;
      // The Engine row covers the whole engine root, not just the bin/ dir the binary sits in.
      const engineBytes = statSync(binPath).size + 32;

      expect(disk.components.map((c) => c.label)).toEqual(["Engine", "TTS (Kokoro)"]);
      expect(disk.components[0].sizeBytes).toBe(engineBytes);
      expect(disk.componentTotalBytes).toBe(engineBytes + 64);
      // The engine lives under the cache, so its bytes are counted once, not twice.
      expect(disk.totalBytes).toBe(engineBytes + 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("an engine installed outside the cache is added to the total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-disk-outside-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(dir, "opt", "engine", "bin"));
    mkdirSync(join(cache, "models", "kokoro-82m"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voice.bin"), "x".repeat(64));

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const disk = (await collectStatus({ disk: true })).disk!;
      expect(disk.totalBytes).toBe(64 + statSync(binPath).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("a sibling directory sharing the cache path prefix is counted (#790)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-disk-sibling-"));
    const cache = join(dir, ".cache", "kesha");
    // `<cache>-alt` is a string prefix match for the cache but is not inside it.
    const binPath = writeFakeEngine(join(`${cache}-alt`, "bin"));
    mkdirSync(join(cache, "models", "kokoro-82m"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voice.bin"), "x".repeat(64));

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const disk = (await collectStatus({ disk: true })).disk!;
      expect(disk.totalBytes).toBe(64 + statSync(binPath).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("an engine rooted at the cache itself is counted once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-disk-atroot-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "bin"));
    mkdirSync(join(cache, "models", "kokoro-82m"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voice.bin"), "x".repeat(64));

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      const disk = (await collectStatus({ disk: true })).disk!;
      expect(disk.totalBytes).toBe(64 + statSync(binPath).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("a trailing separator on KESHA_CACHE_DIR does not double-count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-disk-trailing-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"));
    mkdirSync(join(cache, "models", "kokoro-82m"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voice.bin"), "x".repeat(64));

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = `${cache}${sep}`;
    process.env.HOME = dir;
    try {
      const disk = (await collectStatus({ disk: true })).disk!;
      expect(disk.totalBytes).toBe(64 + statSync(binPath).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Every legacy FluidAudio root is home-relative, so `--disk` was untestable until the home
// could be injected — which is why the honest total was deferred out of #820 (#688).
describe("collectStatus FluidAudio accounting (#688)", () => {
  const restoreEnv = saveEngineEnv();

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  const ASR_FILES = [
    "Preprocessor.mlmodelc",
    "Encoder.mlmodelc",
    "Decoder.mlmodelc",
    "JointDecisionv3.mlmodelc",
    "parakeet_vocab.json",
  ];

  function write(path: string, bytes: number): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x".repeat(bytes));
  }

  /** A cache with an engine and a Kokoro model, plus a home with no FluidAudio tree at all. */
  function stage(
    prefix: string,
    backend = "fake-coreml",
  ): { dir: string; fluidHome: string; cache: string; binPath: string } {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const fluidHome = mkdtempSync(join(tmpdir(), `${prefix}home-`));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"), {
      protocolVersion: 3,
      backend,
      features: [],
    });
    write(join(cache, "models", "kokoro-82m", "voice.bin"), 64);

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    return { dir, fluidHome, cache, binPath };
  }

  posixEngineTest("a machine split across both layouts counts each subsystem once", async () => {
    const { dir, fluidHome, cache, binPath } = stage("kesha-status-fluid-mixed-");
    const fluidRoot = join(fluidHome, "Library", "Application Support", "FluidAudio");
    for (const file of ASR_FILES) write(join(fluidRoot, "Models", "parakeet-tdt-0.6b-v3", file), 10);
    write(join(fluidRoot, "Models", "parakeet-tdt-0.6b-v3-coreml", "Encoder.mlmodelc"), 20);
    write(join(cache, "fluidaudio", "kokoro-82m-coreml", "bundle.bin"), 128);

    try {
      const disk = (await collectStatus({ disk: true, homeDir: fluidHome })).disk!;

      expect(disk.totalBytes).toBe(statSync(binPath).size + 64 + 128);
      expect(disk.externalRoots).toEqual([
        {
          path: fluidRoot,
          sizeBytes: 70,
          subsystems: [
            {
              label: "ASR (Parakeet)",
              path: join(fluidRoot, "Models", "parakeet-tdt-0.6b-v3"),
              sizeBytes: 50,
            },
          ],
          otherBytes: 20,
        },
      ]);
      expect(disk.externalTotalBytes).toBe(70);
      expect(disk.grandTotalBytes).toBe(disk.totalBytes + 70);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fluidHome, { recursive: true, force: true });
    }
  });

  posixEngineTest("an install predating #688 puts all three legacy roots in the total", async () => {
    const { dir, fluidHome, binPath } = stage("kesha-status-fluid-legacy-");
    const support = join(fluidHome, "Library", "Application Support");
    for (const file of ASR_FILES) {
      write(join(support, "FluidAudio", "Models", "parakeet-tdt-0.6b-v3", file), 10);
    }
    write(join(fluidHome, ".cache", "fluidaudio", "Models", "kokoro-82m-coreml", "b.bin"), 100);
    write(join(fluidHome, ".cache", "fluidaudio", "Models", "kokoro", "g2p_vocab.json"), 30);
    write(join(support, "fluidaudio-rs", "SortformerCompiled", "c.mlmodelc"), 200);

    try {
      const disk = (await collectStatus({ disk: true, homeDir: fluidHome })).disk!;

      expect(disk.externalRoots.map((r) => r.sizeBytes)).toEqual([50, 130, 200]);
      expect(disk.externalRoots.flatMap((r) => r.subsystems.map((s) => s.label))).toEqual([
        "ASR (Parakeet)",
        "TTS (Kokoro ANE)",
        "TTS (Kokoro G2P)",
        "Diarization (Sortformer)",
      ]);
      expect(disk.grandTotalBytes).toBe(statSync(binPath).size + 64 + 380);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fluidHome, { recursive: true, force: true });
    }
  });

  // Otherwise a relocated ~800 MB of ANE bundles shows up only as "other cache files" (#688).
  posixEngineTest("a CoreML engine itemises the FluidAudio bytes inside the cache", async () => {
    const { dir, fluidHome, cache } = stage("kesha-status-fluid-incache-", "coreml");
    write(join(cache, "fluidaudio", "kokoro-82m-coreml", "bundle.bin"), 128);

    try {
      const disk = (await collectStatus({ disk: true, homeDir: fluidHome })).disk!;
      expect(disk.components.find((c) => c.label === "FluidAudio (in cache)")?.sizeBytes).toBe(128);
      expect(disk.externalRoots).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fluidHome, { recursive: true, force: true });
    }
  });

  posixEngineTest("a fresh install reports no external root and no inflated total", async () => {
    const { dir, fluidHome } = stage("kesha-status-fluid-fresh-");
    try {
      const disk = (await collectStatus({ disk: true, homeDir: fluidHome })).disk!;
      expect(disk.externalRoots).toEqual([]);
      expect(disk.externalTotalBytes).toBe(0);
      expect(disk.grandTotalBytes).toBe(disk.totalBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fluidHome, { recursive: true, force: true });
    }
  });
});

describe("collectStatus voice inventory", () => {
  const restoreEnv = saveEngineEnv();

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  posixEngineTest("a half-downloaded Vosk model advertises no Russian voices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-vosk-partial-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"));
    const vosk = join(cache, "models", "vosk-ru");
    mkdirSync(join(vosk, "bert"), { recursive: true });

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      writeFileSync(join(vosk, "bert", "model.onnx"), "bert");
      expect((await collectStatus()).voices).toEqual([]);

      rmSync(join(vosk, "bert", "model.onnx"));
      writeFileSync(join(vosk, "model.onnx"), "model");
      expect((await collectStatus()).voices).toEqual([]);

      writeFileSync(join(vosk, "bert", "model.onnx"), "bert");
      expect((await collectStatus()).voices).toEqual([
        "ru-vosk-f01",
        "ru-vosk-f02",
        "ru-vosk-f03",
        "ru-vosk-m01",
        "ru-vosk-m02",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("voices are listed in sorted order across engines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-voice-order-"));
    const cache = join(dir, ".cache", "kesha");
    const binPath = writeFakeEngine(join(cache, "engine", "bin"));
    mkdirSync(join(cache, "models", "kokoro-82m", "voices"), { recursive: true });
    for (const name of ["zf_xiaobei.bin", "am_michael.bin", "bf_emma.bin"]) {
      writeFileSync(join(cache, "models", "kokoro-82m", "voices", name), "voice");
    }
    mkdirSync(join(cache, "models", "vosk-ru", "bert"), { recursive: true });
    writeFileSync(join(cache, "models", "vosk-ru", "model.onnx"), "model");
    writeFileSync(join(cache, "models", "vosk-ru", "bert", "model.onnx"), "bert");

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.HOME = dir;
    try {
      expect((await collectStatus()).voices).toEqual([
        "en-am_michael",
        "en-bf_emma",
        "en-zf_xiaobei",
        "ru-vosk-f01",
        "ru-vosk-f02",
        "ru-vosk-f03",
        "ru-vosk-m01",
        "ru-vosk-m02",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the runtime block describes the running process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-runtime-"));
    process.env.KESHA_ENGINE_BIN = join(dir, "nope", "kesha-engine");
    process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
    process.env.HOME = dir;
    try {
      expect((await collectStatus()).runtime).toEqual({
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("an engine the OS refuses to run reports capabilities as null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-unrunnable-"));
    const binDir = join(dir, ".cache", "kesha", "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o644);

    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
    process.env.HOME = dir;
    try {
      const report = await collectStatus();
      expect(report.engine.installed).toBe(true);
      expect(JSON.parse(JSON.stringify(report)).engine).toHaveProperty("capabilities", null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kesha status --json stdout discipline (#647)", () => {
  test("stdout is exactly one JSON object and the hint stays off stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-json-cli-"));
    const proc = Bun.spawn([process.execPath, "bin/kesha.js", "status", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        KESHA_ENGINE_BIN: join(dir, "nope", "kesha-engine"),
        KESHA_CACHE_DIR: join(dir, ".cache", "kesha"),
        HOME: dir,
        NO_COLOR: "1",
      },
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.engine.installed).toBe(false);
      expect(parsed.hint).toContain("kesha ins");
      // The hint ships in the payload, so stderr must not repeat it.
      expect(stderr).not.toContain("kesha ins");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("human status output is a load-bearing contract (#647)", () => {
  // Frozen for the Raycast probe's fallback on CLIs too old for `--json` — rewording breaks Store users.
  test("the Binary line still carries the `not installed` marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-marker-"));
    const proc = Bun.spawn([process.execPath, "bin/kesha.js", "status"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        KESHA_ENGINE_BIN: join(dir, "nope", "kesha-engine"),
        KESHA_CACHE_DIR: join(dir, ".cache", "kesha"),
        HOME: dir,
        NO_COLOR: "1",
      },
    });
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const binaryLine = stdout.split("\n").find((l) => l.includes("Binary:"));
      expect(binaryLine).toBeDefined();
      expect(binaryLine!).toContain("not installed");
      // The human path has no payload to carry the hint, so it has to reach stderr.
      expect(stderr).toContain("kesha install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #801: the human path is where the false clean bill was read — the mute engine printed
  // a green Binary line and nothing on stderr at all.
  posixEngineTest("a mute engine reaches stderr with the repair command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-status-mute-"));
    const binDir = join(dir, ".cache", "kesha", "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    const proc = Bun.spawn([process.execPath, "bin/kesha.js", "status"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        KESHA_ENGINE_BIN: binPath,
        KESHA_CACHE_DIR: join(dir, ".cache", "kesha"),
        HOME: dir,
        NO_COLOR: "1",
      },
    });
    try {
      const [, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      expect(stderr).toContain("not functional (reports no capabilities)");
      expect(stderr).toContain("kesha install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
