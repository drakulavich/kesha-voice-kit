import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gunzipSync } from "node:zlib";
import {
  collectDoctorReport,
  engineVersionState,
  formatDoctorReport,
  redactDiagnosticValue,
  type DoctorReport,
} from "../../src/doctor";
import { collectStatus } from "../../src/status";
import { createSupportBundle } from "../../src/support-bundle";
import { engineVersion, packageName, packageVersion } from "../../src/package-info";
import { enableStats } from "../../src/stats";

const fakeCapabilities = {
  protocolVersion: 2,
  backend: "fake-coreml",
  features: ["transcribe.segments", "transcribe.diarize"],
};

function writeFakeEngine(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const posixEngineTest = process.platform === "win32" ? test.skip : test;

describe("redactDiagnosticValue", () => {
  test("redacts secret-like keys", () => {
    expect(redactDiagnosticValue("API_KEY", "secret", "/tmp/home")).toBe("[REDACTED]");
    expect(redactDiagnosticValue("GITHUB_TOKEN", "secret", "/tmp/home")).toBe("[REDACTED]");
    expect(redactDiagnosticValue("MONKEY_MODE", "banana", "/tmp/home")).toBe("banana");
  });

  test("redacts home directory paths", () => {
    expect(redactDiagnosticValue("KESHA_CACHE_DIR", "/tmp/home/.cache/kesha", "/tmp/home")).toBe("~/.cache/kesha");
    expect(redactDiagnosticValue("KESHA_CACHE_DIR", "/tmp/home", "/tmp/home")).toBe("~");
    expect(
      redactDiagnosticValue(
        "KESHA_CACHE_DIR",
        "C:\\Users\\Runner\\.cache\\kesha",
        "C:\\Users\\Runner",
      ),
    ).toBe("~/.cache/kesha");
    expect(
      redactDiagnosticValue(
        "probeError",
        "spawn /tmp/home/.cache/kesha/engine/bin/kesha-engine ENOENT",
        "/tmp/home",
      ),
    ).toBe("spawn ~/.cache/kesha/engine/bin/kesha-engine ENOENT");
  });

  test("strips credentials and query strings from URLs", () => {
    expect(
      redactDiagnosticValue(
        "KESHA_MODEL_MIRROR",
        "https://user:pass@example.com/kesha?token=abc#frag",
        "/tmp/home",
      ),
    ).toBe("https://example.com/kesha");
    expect(
      redactDiagnosticValue(
        "KESHA_MODEL_MIRROR",
        "https://user:pass@example.com/tmp/home/mirror?token=abc",
        "/tmp/home",
      ),
    ).toBe("https://example.com/~/mirror");
  });

  test("leaves malformed URL-like values unchanged", () => {
    expect(redactDiagnosticValue("KESHA_MODEL_MIRROR", "https://[broken", "/tmp/home")).toBe(
      "https://[broken",
    );
  });

  test("a value that never mentions home is handed back byte for byte", () => {
    expect(redactDiagnosticValue("KESHA_CACHE_DIR", "/srv/kesha/", "/tmp/home")).toBe("/srv/kesha/");
  });

  test("with no home directory known, nothing is rewritten as one", () => {
    expect(redactDiagnosticValue("KESHA_CACHE_DIR", "/srv/kesha", "")).toBe("/srv/kesha");
  });

  posixEngineTest("a directory that only differs in case is a different directory", () => {
    expect(redactDiagnosticValue("KESHA_CACHE_DIR", "/tmp/Home/cache", "/tmp/home")).toBe(
      "/tmp/Home/cache",
    );
  });
});

describe("collectDoctorReport", () => {
  const savedEnv = {
    HOME: process.env.HOME,
    KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
    KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
    KESHA_MODEL_MIRROR: process.env.KESHA_MODEL_MIRROR,
    KESHA_STATS_DB: process.env.KESHA_STATS_DB,
    KESHA_LOG_DIR: process.env.KESHA_LOG_DIR,
    KESHA_DEBUG: process.env.KESHA_DEBUG,
    KESHA_DEBUG_FD: process.env.KESHA_DEBUG_FD,
  };

  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  test("reports missing engine without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");
      process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
      process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
      process.env.KESHA_LOG_DIR = join(dir, "logs");
      process.env.KESHA_MODEL_MIRROR = "https://user:pass@example.com/kesha?token=abc";
      process.env.KESHA_DEBUG = "1";

      mkdirSync(join(dir, ".cache", "kesha", "models", "silero-vad"), { recursive: true });
      writeFileSync(join(dir, ".cache", "kesha", "models", "silero-vad", "model.onnx"), "vad");
      mkdirSync(process.env.KESHA_LOG_DIR, { recursive: true });
      writeFileSync(join(process.env.KESHA_LOG_DIR, "kesha.ndjson"), "diagnostic\n");
      writeFileSync(join(process.env.KESHA_LOG_DIR, "kesha.1.ndjson"), "rotated\n");
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

      const report = await collectDoctorReport({ redact: true });
      expect(report.redacted).toBe(true);
      expect(report.engine.installed).toBe(false);
      expect(report.engine.path).toBe("~/engine/bin/kesha-engine");
      expect(report.cache.path).toBe("~/.cache/kesha");
      expect(report.cache.totalBytes).toBe("vad".length);
      expect(report.env.KESHA_MODEL_MIRROR).toBe("https://example.com/kesha");
      expect(report.env.KESHA_DEBUG).toBe("1");
      expect("runCount" in report.stats).toBe(true);
      expect(report.diagnosticLogs.mode).toBe("retain-on-failure");
      expect(report.diagnosticLogs.dir).toBe("~/logs");
      expect(report.diagnosticLogs.activePath).toBe("~/logs/kesha.ndjson");
      expect(report.diagnosticLogs.statePath).toBe("~/logs/diagnostic-logs.json");
      expect(report.diagnosticLogs.exists).toBe(true);
      expect(report.diagnosticLogs.activeSizeBytes).toBe("diagnostic\n".length);
      expect(report.diagnosticLogs.totalSizeBytes).toBe("diagnostic\n".length + "rotated\n".length);
      expect(report.diagnosticLogs.rotatedFiles).toEqual(["kesha.1.ndjson"]);

      expect(report.cache.externalRoots).toEqual([
        {
          path: "~/.cache/fluidaudio",
          sizeBytes: 6,
          subsystems: [
            { label: "TTS (Kokoro G2P)", path: "~/.cache/fluidaudio/Models/kokoro", sizeBytes: 6 },
          ],
          otherBytes: 0,
        },
      ]);

      const fluidOptional = report.optionalComponents.find(
        (component) => component.name === "FluidAudio Kokoro cache",
      );
      if (process.platform === "darwin" && process.arch === "arm64") {
        expect(fluidOptional).toMatchObject({
          path: "~/.cache/fluidaudio/Models/kokoro",
          exists: true,
        });
      } else {
        expect(fluidOptional).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports the FluidAudio root unredacted when redaction is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-fluid-kokoro-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");
      process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
      process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
      mkdirSync(join(dir, ".cache", "fluidaudio", "Models", "kokoro", "kokoro_21_5s.mlmodelc"), {
        recursive: true,
      });
      writeFileSync(
        join(
          dir,
          ".cache",
          "fluidaudio",
          "Models",
          "kokoro",
          "kokoro_21_5s.mlmodelc",
          "coremldata.bin",
        ),
        "coreml",
      );

      const report = await collectDoctorReport({ redact: false });
      const root = report.cache.externalRoots[0];
      expect(root?.path).toBe(join(dir, ".cache", "fluidaudio"));
      expect(root?.subsystems.map((s) => s.path)).toEqual([
        join(dir, ".cache", "fluidaudio", "Models", "kokoro"),
      ]);
      expect(report.cache.grandTotalBytes).toBe(report.cache.totalBytes + root!.sizeBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formats a human-readable report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-format-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");
      process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
      process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
      process.env.KESHA_LOG_DIR = join(dir, "logs");
      mkdirSync(process.env.KESHA_LOG_DIR, { recursive: true });
      writeFileSync(join(process.env.KESHA_LOG_DIR, "kesha.ndjson"), "diagnostic\n");

      // Stage a >1 KB cached model so the cache-size line exercises
      // humanBytes' KB/MB scaling, not just the sub-1 KB "N B" branch.
      mkdirSync(join(dir, ".cache", "kesha", "models", "silero-vad"), { recursive: true });
      writeFileSync(
        join(dir, ".cache", "kesha", "models", "silero-vad", "model.onnx"),
        "x".repeat(4096),
      );

      const output = formatDoctorReport(await collectDoctorReport({ redact: true }));
      expect(output).toContain("Kesha Doctor");
      expect(output).toContain("Runtime:");
      expect(output).toContain("Engine:");
      expect(output).toContain("Diagnostic logs:");
      expect(output).toContain("Mode: retain-on-failure");
      expect(output).toContain("Path: ~/logs/kesha.ndjson");
      expect(output).toContain("Rotated files: 0");
      expect(output).toContain("Environment:");
      expect(output).toMatch(/Cache:.*KB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("reports diagnostic log collection errors without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-log-error-test-"));
    const logDir = join(dir, "logs");
    try {
      process.env.HOME = dir;
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");
      process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
      process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
      process.env.KESHA_LOG_DIR = logDir;
      mkdirSync(logDir, { recursive: true });
      chmodSync(logDir, 0o000);

      const report = await collectDoctorReport({ redact: true });
      expect(report.diagnosticLogs.dir).toBe("~/logs");
      expect(report.diagnosticLogs.activePath).toBe("~/logs/kesha.ndjson");
      expect(report.diagnosticLogs.statePath).toBe("~/logs/diagnostic-logs.json");
      expect(report.diagnosticLogs.exists).toBe(false);
      expect(report.diagnosticLogs.totalSizeBytes).toBe(0);
      // An unreadable directory still has to report the configuration in force, or the
      // report reads as if rotation were off.
      expect(report.diagnosticLogs.mode).toBe("retain-on-failure");
      expect(report.diagnosticLogs.maxBytes).toBe(10 * 1024 * 1024);
      expect(report.diagnosticLogs.retain).toBe(5);
      expect(report.diagnosticLogs.rotatedFiles).toEqual([]);
      expect(report.diagnosticLogs.error).toContain("~/logs");
      expect(report.diagnosticLogs.error).not.toContain(dir);

      const output = formatDoctorReport(report);
      expect(output).toContain("Diagnostic logs:");
      expect(output).toContain("Error:");
    } finally {
      chmodSync(logDir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("reports installed engine capabilities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-engine-test-"));
    try {
      const binDir = join(dir, "engine", "bin");
      mkdirSync(binDir, { recursive: true });
      const binPath = join(binDir, "kesha-engine");
      writeFakeEngine(
        binPath,
        `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '${JSON.stringify(fakeCapabilities)}'
  exit 0
fi
exit 2
`,
      );
      process.env.HOME = dir;
      process.env.KESHA_ENGINE_BIN = binPath;
      process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
      process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");

      const report = await collectDoctorReport({ redact: true });
      expect(report.engine.installed).toBe(true);
      expect(report.engine.capabilities).toEqual(fakeCapabilities);
      expect(report.engine.probeError).toBeNull();

      const output = formatDoctorReport(report);
      expect(output).toContain("fake-coreml, protocol v2");
      expect(output).toContain("transcribe.diarize");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formats stats collection errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-stats-error-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");
      process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
      process.env.KESHA_STATS_DB = dir;

      const output = formatDoctorReport(await collectDoctorReport({ redact: true }));
      expect(output).toContain("Stats:");
      expect(output).toContain("Error:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe("the human report states what each component is doing (#770)", () => {
  function cacheReport(overrides: Partial<DoctorReport["cache"]> = {}): DoctorReport["cache"] {
    return {
      path: "/cache",
      exists: true,
      totalBytes: 4096,
      components: [],
      externalRoots: [],
      externalTotalBytes: 0,
      grandTotalBytes: 4096,
      ...overrides,
    };
  }

  function doctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
    return {
      generatedAt: "2026-05-17T12:00:00.000Z",
      redacted: false,
      package: { name: "kesha", version: "9.9.9" },
      runtime: { bunVersion: "1.9.9", platform: "testos", arch: "testarch" },
      engine: {
        path: "/cache/engine/bin/kesha-engine",
        installed: true,
        versionMarker: "1.0.0",
        pinnedVersion: "1.0.0",
        versionState: "matches-pin",
        runnable: true,
        capabilities: { protocolVersion: 3, backend: "onnx", features: ["tts", "diarize"] },
        probeError: null,
      },
      cache: cacheReport({ totalBytes: 4096 }),
      optionalComponents: [],
      stats: {
        enabled: true,
        dbPath: "/stats.sqlite",
        runCount: 3,
        exists: true,
        retentionDays: 90,
      },
      diagnosticLogs: {
        dir: "/logs",
        activePath: "/logs/kesha.ndjson",
        statePath: "/logs/diagnostic-logs.json",
        exists: true,
        activeSizeBytes: 2048,
        rotatedFiles: [],
        totalSizeBytes: 2048,
        mode: "retain-on-failure",
        maxBytes: 10 * 1024 * 1024,
        retain: 5,
      },
      env: {},
      ...overrides,
    };
  }

  function engineLine(report: DoctorReport): string {
    return formatDoctorReport(report).split("\n").find((l) => l.includes("Binary:"))!;
  }

  test("the binary is missing, installed, or corrupt — and never two of those", () => {
    expect(engineLine(doctorReport({ engine: { ...doctorReport().engine, installed: false } }))).toContain(
      "(missing)",
    );
    expect(engineLine(doctorReport())).toContain("(installed)");

    const corrupt = engineLine(
      doctorReport({ engine: { ...doctorReport().engine, runnable: false } }),
    );
    expect(corrupt).toContain("corrupt");
    expect(corrupt).toContain("kesha install");
    expect(corrupt).not.toContain("(installed)");
  });

  // #801: an engine that spawns is not thereby working. Nothing may read clean while
  // the binary is present and its capabilities are null.
  test("a runnable engine with no capabilities is a fault of its own", () => {
    const mute = engineLine(
      doctorReport({ engine: { ...doctorReport().engine, capabilities: null } }),
    );
    expect(mute).toContain("installed but not functional (reports no capabilities)");
    expect(mute).toContain("kesha install");
    expect(mute).not.toContain("(installed)");
    expect(mute).not.toContain("corrupt");
  });

  test("an optional component's state separates corrupt from missing", () => {
    const output = formatDoctorReport(
      doctorReport({
        optionalComponents: [
          { name: "Present", path: "/a", exists: true, sizeBytes: 1, runnable: true },
          { name: "Broken", path: "/b", exists: true, sizeBytes: 1, runnable: false },
          { name: "Absent", path: "/c", exists: false, sizeBytes: 0 },
        ],
      }),
    );
    expect(output).toContain("Present: installed");
    expect(output).toContain("Broken: installed but not executable (corrupt)");
    expect(output).toContain("Absent: missing");
  });

  test("each version state reads differently, and drift names its remedy", () => {
    const engine = doctorReport().engine;
    const drift = formatDoctorReport(
      doctorReport({
        engine: { ...engine, versionMarker: "8.8.8", versionState: "differs-from-pin" },
      }),
    );
    expect(drift).toContain("installed v8.8.8 differs from the pinned v1.0.0");
    expect(drift).toContain("kesha install");

    expect(
      formatDoctorReport(
        doctorReport({ engine: { ...engine, versionMarker: null, versionState: "unrecorded" } }),
      ),
    ).toContain("Version marker: missing");
    expect(
      formatDoctorReport(
        doctorReport({
          engine: { ...engine, installed: false, versionMarker: null, versionState: "unrecorded" },
        }),
      ),
    ).toContain("Version state: no engine installed");
  });

  test("capabilities carry the probe error when there are none to report", () => {
    const engine = doctorReport().engine;
    expect(formatDoctorReport(doctorReport())).toContain(
      "Capabilities: onnx, protocol v3, tts, diarize",
    );
    expect(
      formatDoctorReport(
        doctorReport({ engine: { ...engine, capabilities: null, probeError: "it exploded" } }),
      ),
    ).toContain("Capabilities: it exploded");
    expect(
      formatDoctorReport(
        doctorReport({ engine: { ...engine, capabilities: null, probeError: null } }),
      ),
    ).toContain("Capabilities: not available");
  });

  test("a cache row shows its size when present and `missing` when not", () => {
    const output = formatDoctorReport(
      doctorReport({
        cache: cacheReport({
          totalBytes: 8192,
          components: [
            { label: "Engine", path: "/cache/engine", exists: true, sizeBytes: 4096 },
            { label: "TTS (Vosk)", path: "/cache/models/vosk-ru", exists: false, sizeBytes: 0 },
          ],
        }),
      }),
    );
    expect(output).toContain("Cache: /cache (8.0 KB)");
    expect(output).toContain("Engine: 4.0 KB");
    expect(output).toContain("TTS (Vosk): missing");

    expect(
      formatDoctorReport(doctorReport({ cache: cacheReport({ exists: false, totalBytes: 0 }) })),
    ).toContain("Cache: /cache (missing)");
  });

  test("a FluidAudio root outside the cache is named with its path and the grand total", () => {
    const output = formatDoctorReport(
      doctorReport({
        cache: cacheReport({
          totalBytes: 8192,
          externalRoots: [
            {
              path: "/home/Library/Application Support/FluidAudio",
              sizeBytes: 4096,
              subsystems: [{ label: "ASR (Parakeet)", path: "/home/asr", sizeBytes: 3072 }],
              otherBytes: 1024,
            },
          ],
          externalTotalBytes: 4096,
          grandTotalBytes: 12288,
        }),
      }),
    );
    expect(output).toContain("FluidAudio caches outside the Kesha cache:");
    expect(output).toContain("/home/Library/Application Support/FluidAudio: 4.0 KB");
    expect(output).toContain("ASR (Parakeet): 3.0 KB");
    expect(output).toContain("1.0 KB not attributed to any subsystem above");
    expect(output).toContain("Grand total: 12.0 KB");

    expect(formatDoctorReport(doctorReport())).not.toContain("FluidAudio caches outside");
  });

  test("stats report either their counters or the error that hid them", () => {
    const healthy = formatDoctorReport(doctorReport());
    expect(healthy).toContain("Enabled: yes");
    expect(healthy).toContain("Runs: 3");
    expect(healthy).toContain("Database: /stats.sqlite");

    expect(
      formatDoctorReport(
        doctorReport({
          stats: {
            enabled: false,
            dbPath: "/stats.sqlite",
            runCount: 0,
            exists: true,
            retentionDays: null,
          },
        }),
      ),
    ).toContain("Enabled: no");

    const broken = formatDoctorReport(doctorReport({ stats: { error: "disk on fire" } }));
    expect(broken).toContain("Error: disk on fire");
    expect(broken).not.toContain("Enabled:");
  });

  test("a healthy log directory reports no error line", () => {
    expect(formatDoctorReport(doctorReport())).not.toMatch(/Diagnostic logs:[\s\S]*Error:/);
  });

  test("unset environment variables are named as unset rather than blank", () => {
    const output = formatDoctorReport(
      doctorReport({ env: { KESHA_CACHE_DIR: "/cache", KESHA_DEBUG: null } }),
    );
    expect(output).toContain("KESHA_CACHE_DIR: /cache");
    expect(output).toContain("KESHA_DEBUG: unset");
  });

  test("the report is line-oriented and ends with a newline", () => {
    const output = formatDoctorReport(doctorReport());
    expect(output.split("\n")).toContain("Kesha Doctor");
    expect(output.endsWith("\n")).toBe(true);
  });
});

describe("collectDoctorReport probe and cache accounting", () => {
  const savedEnv = {
    HOME: process.env.HOME,
    KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
    KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
    KESHA_STATS_DB: process.env.KESHA_STATS_DB,
  };

  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  function stage(prefix: string): { dir: string; cache: string; binDir: string } {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const cache = join(dir, ".cache", "kesha");
    const binDir = join(cache, "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    process.env.HOME = dir;
    process.env.KESHA_ENGINE_BIN = join(binDir, "kesha-engine");
    process.env.KESHA_CACHE_DIR = cache;
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
    return { dir, cache, binDir };
  }

  test("an absent engine is not probed, so it carries no probe error", async () => {
    const { dir } = stage("kesha-doctor-absent-probe-");
    try {
      const report = await collectDoctorReport();
      expect(report.engine.installed).toBe(false);
      expect(report.engine.runnable).toBe(false);
      expect(report.engine.probeError).toBeNull();
      expect(report.engine.capabilities).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #801: this is the #796 stub verbatim — it ran, so doctor called it installed.
  posixEngineTest("an engine that runs but describes nothing is a fault, not a footnote", async () => {
    const { dir, binDir } = stage("kesha-doctor-mute-engine-");
    writeFakeEngine(join(binDir, "kesha-engine"), "#!/bin/sh\nexit 0\n");
    try {
      const report = await collectDoctorReport();
      expect(report.engine.installed).toBe(true);
      expect(report.engine.runnable).toBe(true);
      expect(report.engine.capabilities).toBeNull();
      const binaryLine = formatDoctorReport(report)
        .split("\n")
        .find((l) => l.includes("Binary:"))!;
      expect(binaryLine).toContain("installed but not functional (reports no capabilities)");
      expect(binaryLine).toContain("kesha install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("capabilities that do not parse read as the same fault as none", async () => {
    const { dir, binDir } = stage("kesha-doctor-silent-engine-");
    writeFakeEngine(join(binDir, "kesha-engine"), "#!/bin/sh\nexit 2\n");
    try {
      const report = await collectDoctorReport();
      expect(report.engine.runnable).toBe(true);
      expect(report.engine.capabilities).toBeNull();
      expect(report.engine.probeError).toContain("reports no capabilities");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("a CoreML engine gets the in-cache FluidAudio row, not the ONNX model dir", async () => {
    const { dir, binDir } = stage("kesha-doctor-coreml-cache-");
    writeFakeEngine(
      join(binDir, "kesha-engine"),
      `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '{"protocolVersion":3,"backend":"coreml","features":[]}'
  exit 0
fi
exit 2
`,
    );
    try {
      const labels = (await collectDoctorReport()).cache.components.map((c) => c.label);
      // The engine roots FluidAudio inside the cache, so those bytes belong to the cache
      // breakdown rather than to the external-root list (#688).
      expect(labels).toContain("FluidAudio (in cache)");
      expect(labels).not.toContain("ASR (Parakeet)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("an ONNX engine keeps the ONNX model dir and no in-cache FluidAudio row", async () => {
    const { dir, binDir } = stage("kesha-doctor-onnx-cache-");
    writeFakeEngine(
      join(binDir, "kesha-engine"),
      `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '{"protocolVersion":3,"backend":"onnx","features":[]}'
  exit 0
fi
exit 2
`,
    );
    try {
      const labels = (await collectDoctorReport()).cache.components.map((c) => c.label);
      expect(labels).toContain("ASR (Parakeet)");
      expect(labels).not.toContain("FluidAudio (in cache)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("an engine inside the cache is counted once, outside it is added", async () => {
    const { dir, cache, binDir } = stage("kesha-doctor-cache-total-");
    writeFakeEngine(join(binDir, "kesha-engine"), "#!/bin/sh\nexit 2\n");
    mkdirSync(join(cache, "models", "silero-vad"), { recursive: true });
    writeFileSync(join(cache, "models", "silero-vad", "model.onnx"), "x".repeat(128));
    const engineBytes = readFileSync(join(binDir, "kesha-engine")).length;
    try {
      expect((await collectDoctorReport()).cache.totalBytes).toBe(engineBytes + 128);

      const outside = join(dir, "opt", "engine", "bin");
      mkdirSync(outside, { recursive: true });
      writeFakeEngine(join(outside, "kesha-engine"), "#!/bin/sh\nexit 2\n");
      process.env.KESHA_ENGINE_BIN = join(outside, "kesha-engine");
      expect((await collectDoctorReport()).cache.totalBytes).toBe(
        engineBytes + 128 + engineBytes,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each optional component measures its own directory and names its install flag", async () => {
    const { dir, cache } = stage("kesha-doctor-optional-");
    mkdirSync(join(cache, "models", "silero-vad"), { recursive: true });
    writeFileSync(join(cache, "models", "silero-vad", "model.onnx"), "x".repeat(128));
    mkdirSync(join(cache, "models", "kokoro-82m"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "model.onnx"), "x".repeat(64));
    try {
      const components = (await collectDoctorReport()).optionalComponents;
      const byName = (name: string) => components.find((c) => c.name === name)!;

      expect(byName("VAD (Silero)")).toMatchObject({ exists: true, sizeBytes: 128 });
      expect(byName("VAD (Silero)").note).toContain("kesha install --vad");
      expect(byName("TTS (Kokoro)")).toMatchObject({ exists: true, sizeBytes: 64 });
      expect(byName("TTS (Kokoro)").note).toContain("kesha install --tts");
      expect(byName("TTS (Vosk RU)")).toMatchObject({ exists: false, sizeBytes: 0 });
      expect(byName("TTS (Vosk RU)").note).toContain("kesha install --tts");
      expect(byName("Diarization (Sortformer)")).toMatchObject({ exists: false, sizeBytes: 0 });
      expect(byName("Diarization (Sortformer)").note).toContain("kesha install --diarize");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the package and runtime blocks describe this install", async () => {
    const { dir } = stage("kesha-doctor-identity-");
    try {
      const report = await collectDoctorReport();
      expect(report.package).toEqual({ name: packageName, version: packageVersion });
      expect(report.runtime).toEqual({
        bunVersion: Bun.version,
        platform: process.platform,
        arch: process.arch,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recorded runs surface in the stats section", async () => {
    const { dir } = stage("kesha-doctor-stats-counters-");
    try {
      enableStats();
      const output = formatDoctorReport(await collectDoctorReport());
      expect(output).toContain("Enabled: yes");
      expect(output).toContain("Runs: 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createSupportBundle", () => {
  const savedEnv = {
    HOME: process.env.HOME,
    KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
    KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
    KESHA_MODEL_MIRROR: process.env.KESHA_MODEL_MIRROR,
    KESHA_STATS_DB: process.env.KESHA_STATS_DB,
    KESHA_DEBUG: process.env.KESHA_DEBUG,
    KESHA_DEBUG_FD: process.env.KESHA_DEBUG_FD,
  };

  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  test("creates a redacted tar.gz archive safe to attach to support issues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-support-bundle-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_ENGINE_BIN = join(dir, "engine", "bin", "kesha-engine");
      process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
      process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
      process.env.KESHA_LOG_DIR = join(dir, "logs");
      process.env.KESHA_MODEL_MIRROR = "https://user:pass@example.com/kesha?token=abc";
      mkdirSync(join(dir, ".cache", "kesha", "models", "silero-vad"), { recursive: true });
      writeFileSync(join(dir, ".cache", "kesha", "models", "silero-vad", "model.onnx"), "vad");
      mkdirSync(process.env.KESHA_LOG_DIR, { recursive: true });
      writeFileSync(
        join(process.env.KESHA_LOG_DIR, "kesha.ndjson"),
        `${JSON.stringify({ event: "command.start", command: "transcribe", status: "failed" })}\n`,
      );

      const output = join(dir, "bundle.tar.gz");
      const result = await createSupportBundle({
        output,
        now: new Date("2026-05-17T12:34:56Z"),
      });
      const archive = gunzipSync(readFileSync(output)).toString("utf8");

      expect(result.path).toBe(output);
      expect(result.entries).toContain("bundle/doctor.json");
      expect(result.entries).toContain("bundle/doctor.txt");
      expect(result.entries).toContain("bundle/manifest.json");
      expect(result.entries).not.toContain("bundle/diagnostic-logs/kesha.ndjson");
      expect(archive).toContain("bundle/README.txt");
      expect(archive).toContain('"redacted": true');
      expect(archive).toContain('"included": false');
      expect(archive).not.toContain("command.start");
      expect(archive).toContain("~/engine/bin/kesha-engine");
      expect(archive).toContain("https://example.com/kesha");
      expect(archive).not.toContain(dir);
      expect(archive).not.toContain("user:pass");
      expect(archive).not.toContain("token=abc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("includes bounded diagnostic log tail only when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-support-bundle-logs-test-"));
    try {
      process.env.HOME = dir;
      process.env.KESHA_LOG_DIR = join(dir, "logs");
      mkdirSync(process.env.KESHA_LOG_DIR, { recursive: true });
      writeFileSync(
        join(process.env.KESHA_LOG_DIR, "kesha.ndjson"),
        [
          JSON.stringify({ event: "command.start", command: "say", charBucket: "lt100" }),
          JSON.stringify({ event: "command.finish", command: "say", status: "failed", errorKind: "say_error" }),
          "",
        ].join("\n"),
      );

      const output = join(dir, "bundle.tar.gz");
      const result = await createSupportBundle({
        output,
        includeLogs: true,
        now: new Date("2026-05-17T12:34:56Z"),
      });
      const archive = gunzipSync(readFileSync(output)).toString("utf8");

      expect(result.entries).toContain("bundle/diagnostic-logs/README.txt");
      expect(result.entries).toContain("bundle/diagnostic-logs/kesha.ndjson");
      expect(result.entries).toContain("bundle/diagnostic-logs/status.json");
      expect(archive).toContain('"diagnosticLogs"');
      expect(archive).toContain('"included": true');
      expect(archive).toContain('"event":"command.start"');
      expect(archive).toContain('"event":"command.finish"');
      expect(archive).not.toContain(process.env.KESHA_LOG_DIR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine version drift (#738)", () => {
  const savedEnv = {
    HOME: process.env.HOME,
    KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
    KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
  };

  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  function stageEngine(prefix: string, marker: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    process.env.HOME = dir;
    process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
    const binPath = join(dir, "engine", "bin", "kesha-engine");
    mkdirSync(join(dir, "engine", "bin"), { recursive: true });
    process.env.KESHA_ENGINE_BIN = binPath;
    writeFakeEngine(binPath, "#!/bin/sh\nexit 1\n");
    if (marker !== null) writeFileSync(`${binPath}.version`, `${marker}\n`);
    return dir;
  }

  test("classifies the marker against the pin without conflating a missing one", () => {
    expect(engineVersionState("1.24.7", "1.24.7")).toBe("matches-pin");
    expect(engineVersionState("1.24.8-alpha.1", "1.24.7")).toBe("differs-from-pin");
    expect(engineVersionState(null, "1.24.7")).toBe("unrecorded");
  });

  posixEngineTest("names both versions when an override is installed", async () => {
    const dir = stageEngine("kesha-doctor-drift-", "9.9.9-alpha.1");
    try {
      const report = await collectDoctorReport();
      expect(report.engine.versionState).toBe("differs-from-pin");
      expect(report.engine.versionMarker).toBe("9.9.9-alpha.1");
      expect(report.engine.pinnedVersion).toBe(engineVersion);

      const output = formatDoctorReport(report);
      expect(output).toContain("9.9.9-alpha.1");
      expect(output).toContain(`Pinned version: ${engineVersion}`);
      expect(output).toContain("differs from the pinned");
      expect(output).not.toContain("Binary: " + report.engine.path + " (missing)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("stays quiet when the installed engine matches the pin", async () => {
    const dir = stageEngine("kesha-doctor-nodrift-", engineVersion);
    try {
      const report = await collectDoctorReport();
      expect(report.engine.versionState).toBe("matches-pin");
      expect(formatDoctorReport(report)).toContain("Version state: matches the pin");
      expect(formatDoctorReport(report)).not.toContain("differs from the pinned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("reports a missing marker as its own state, not as drift", async () => {
    const dir = stageEngine("kesha-doctor-nomarker-", null);
    try {
      const report = await collectDoctorReport();
      expect(report.engine.versionState).toBe("unrecorded");

      const output = formatDoctorReport(report);
      expect(output).toContain("Version marker: missing");
      expect(output).toContain("no recorded version beside the binary");
      expect(output).not.toContain("differs from the pinned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #770: a truncated download leaves a file that exists but cannot run. Reporting it as
// "installed" is a false clean from the one command whose job is to find such faults.
describe("doctor separates corrupt components from missing ones", () => {
  const savedEnv = {
    HOME: process.env.HOME,
    KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
    KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
    KESHA_STATS_DB: process.env.KESHA_STATS_DB,
  };

  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  /** Mode 0o755 but not a loadable image, exactly what an interrupted download leaves behind. */
  const TRUNCATED = "\x7fELF\x00\x01\x02truncated";

  function stageInstall(prefix: string, engineBody: string, sidecarBody: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const binDir = join(dir, "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeEngine(join(binDir, "kesha-engine"), engineBody);
    if (sidecarBody !== null) {
      writeFakeEngine(join(binDir, "say-avspeech"), sidecarBody);
      writeFakeEngine(join(binDir, "kesha-textlang"), sidecarBody);
    }
    process.env.HOME = dir;
    process.env.KESHA_ENGINE_BIN = join(binDir, "kesha-engine");
    process.env.KESHA_CACHE_DIR = join(dir, ".cache", "kesha");
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
    return dir;
  }

  function sidecarStates(report: Awaited<ReturnType<typeof collectDoctorReport>>) {
    return report.optionalComponents
      .filter((c) => c.name.endsWith("sidecar"))
      .map((c) => ({ name: c.name, exists: c.exists, runnable: c.runnable }));
  }

  posixEngineTest("a truncated sidecar reports as corrupt, not installed", async () => {
    const dir = stageInstall("kesha-doctor-corrupt-sidecar-", "#!/bin/sh\nexit 0\n", TRUNCATED);
    try {
      const report = await collectDoctorReport();
      expect(sidecarStates(report)).toEqual([
        { name: "AVSpeech sidecar", exists: true, runnable: false },
        { name: "Text language sidecar", exists: true, runnable: false },
      ]);

      const output = formatDoctorReport(report);
      expect(output).toContain("AVSpeech sidecar: installed but not executable (corrupt)");
      expect(output).toContain("Text language sidecar: installed but not executable (corrupt)");
      expect(output).toContain("re-run `kesha install`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The sidecars exit non-zero with no work to do, so "it ran" is the only fair health bar.
  posixEngineTest("a working sidecar still reports as installed", async () => {
    const dir = stageInstall("kesha-doctor-ok-sidecar-", "#!/bin/sh\nexit 0\n", "#!/bin/sh\nexit 1\n");
    try {
      const report = await collectDoctorReport();
      expect(sidecarStates(report)).toEqual([
        { name: "AVSpeech sidecar", exists: true, runnable: true },
        { name: "Text language sidecar", exists: true, runnable: true },
      ]);
      expect(formatDoctorReport(report)).not.toContain("corrupt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("an absent sidecar stays missing rather than corrupt", async () => {
    const dir = stageInstall("kesha-doctor-no-sidecar-", "#!/bin/sh\nexit 0\n", null);
    try {
      const report = await collectDoctorReport();
      expect(sidecarStates(report)).toEqual([
        { name: "AVSpeech sidecar", exists: false, runnable: undefined },
        { name: "Text language sidecar", exists: false, runnable: undefined },
      ]);
      expect(formatDoctorReport(report)).toContain("AVSpeech sidecar: missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixEngineTest("a truncated engine is named as corrupt rather than probed for capabilities", async () => {
    const dir = stageInstall("kesha-doctor-corrupt-engine-", TRUNCATED, null);
    try {
      const report = await collectDoctorReport();
      expect(report.engine.installed).toBe(true);
      expect(report.engine.runnable).toBe(false);
      expect(report.engine.probeError).toContain("does not run");

      const output = formatDoctorReport(report);
      expect(output).toContain(
        `Binary: ${report.engine.path} (installed but not executable (corrupt) - re-run \`kesha install\`)`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("doctor and status agree on the disk total (#790)", () => {
  const savedEnv = {
    HOME: process.env.HOME,
    KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
    KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
    KESHA_STATS_DB: process.env.KESHA_STATS_DB,
  };

  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  posixEngineTest("an engine in a prefix-sharing sibling of the cache counts in both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-status-sibling-"));
    const cache = join(dir, ".cache", "kesha");
    const binDir = join(`${cache}-alt`, "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFakeEngine(
      binPath,
      `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '{"protocolVersion":3,"backend":"onnx","features":[]}'
  exit 0
fi
exit 2
`,
    );
    mkdirSync(join(cache, "models", "kokoro-82m"), { recursive: true });
    writeFileSync(join(cache, "models", "kokoro-82m", "voice.bin"), "x".repeat(64));

    process.env.HOME = dir;
    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
    try {
      const doctorTotal = (await collectDoctorReport()).cache.totalBytes;
      const statusTotal = (await collectStatus({ disk: true })).disk!.totalBytes;

      expect(doctorTotal).toBe(64 + statSync(binPath).size);
      expect(statusTotal).toBe(doctorTotal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Two commands reporting different FluidAudio totals is the #790 failure again, one root
  // further out — so both read the same resolver and the same helper (#688).
  posixEngineTest("both name the same FluidAudio roots and the same grand total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-doctor-status-fluid-"));
    const fluidHome = mkdtempSync(join(tmpdir(), "kesha-doctor-status-fluid-home-"));
    const cache = join(dir, ".cache", "kesha");
    const binDir = join(cache, "engine", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "kesha-engine");
    writeFakeEngine(
      binPath,
      `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '{"protocolVersion":3,"backend":"coreml","features":[]}'
  exit 0
fi
exit 2
`,
    );
    const asr = join(
      fluidHome,
      "Library",
      "Application Support",
      "FluidAudio",
      "Models",
      "parakeet-tdt-0.6b-v3",
    );
    mkdirSync(asr, { recursive: true });
    for (const file of [
      "Preprocessor.mlmodelc",
      "Encoder.mlmodelc",
      "Decoder.mlmodelc",
      "JointDecisionv3.mlmodelc",
      "parakeet_vocab.json",
    ]) {
      writeFileSync(join(asr, file), "x".repeat(10));
    }

    process.env.HOME = dir;
    process.env.KESHA_ENGINE_BIN = binPath;
    process.env.KESHA_CACHE_DIR = cache;
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
    try {
      const doctor = (await collectDoctorReport({ homeDir: fluidHome })).cache;
      const disk = (await collectStatus({ disk: true, homeDir: fluidHome })).disk!;

      expect(doctor.externalRoots).toEqual(disk.externalRoots);
      expect(doctor.externalRoots[0]?.subsystems[0]?.path).toBe(asr);
      expect(doctor.totalBytes).toBe(disk.totalBytes);
      expect(doctor.grandTotalBytes).toBe(disk.grandTotalBytes);
      expect(doctor.grandTotalBytes).toBe(doctor.totalBytes + 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fluidHome, { recursive: true, force: true });
    }
  });
});
