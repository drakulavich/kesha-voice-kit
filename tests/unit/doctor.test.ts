import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gunzipSync } from "node:zlib";
import {
  collectDoctorReport,
  formatDoctorReport,
  redactDiagnosticValue,
} from "../../src/doctor";
import { createSupportBundle } from "../../src/support-bundle";

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
      expect(report.cache.totalBytes).toBeGreaterThan(0);
      expect(report.env.KESHA_MODEL_MIRROR).toBe("https://example.com/kesha");
      expect(report.env.KESHA_DEBUG).toBe("1");
      expect("runCount" in report.stats).toBe(true);
      expect(report.diagnosticLogs.mode).toBe("retain-on-failure");
      expect(report.diagnosticLogs.dir).toBe("~/logs");
      expect(report.diagnosticLogs.activePath).toBe("~/logs/kesha.ndjson");
      expect(report.diagnosticLogs.statePath).toBe("~/logs/diagnostic-logs.json");
      expect(report.diagnosticLogs.exists).toBe(true);
      expect(report.diagnosticLogs.activeSizeBytes).toBeGreaterThan(0);
      expect(report.diagnosticLogs.totalSizeBytes).toBeGreaterThan(report.diagnosticLogs.activeSizeBytes);
      expect(report.diagnosticLogs.rotatedFiles).toEqual(["kesha.1.ndjson"]);

      const fluidCache = report.cache.components.find(
        (component) => component.label === "FluidAudio Kokoro cache (external)",
      );
      const fluidOptional = report.optionalComponents.find(
        (component) => component.name === "FluidAudio Kokoro cache",
      );
      if (process.platform === "darwin" && process.arch === "arm64") {
        expect(fluidCache).toMatchObject({
          path: "~/.cache/fluidaudio/Models/kokoro",
          exists: true,
        });
        expect(fluidCache?.sizeBytes).toBeGreaterThan(0);
        expect(fluidOptional).toMatchObject({
          path: "~/.cache/fluidaudio/Models/kokoro",
          exists: true,
        });
      } else {
        expect(fluidCache).toBeUndefined();
        expect(fluidOptional).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports unredacted FluidAudio Kokoro cache on darwin-arm64", async () => {
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
      const fluidCache = report.cache.components.find(
        (component) => component.label === "FluidAudio Kokoro cache (external)",
      );
      if (process.platform === "darwin" && process.arch === "arm64") {
        expect(fluidCache).toMatchObject({
          path: join(dir, ".cache", "fluidaudio", "Models", "kokoro"),
          exists: true,
        });
        expect(fluidCache?.sizeBytes).toBeGreaterThan(0);
      } else {
        expect(fluidCache).toBeUndefined();
      }
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

  test("formats large cache sizes", () => {
    const output = formatDoctorReport({
      generatedAt: "2026-05-23T00:00:00.000Z",
      redacted: true,
      package: { name: "kesha-test", version: "0.0.0" },
      runtime: { bunVersion: "1.0.0", platform: "darwin", arch: "arm64" },
      engine: {
        path: "~/engine/bin/kesha-engine",
        installed: false,
        versionMarker: null,
        capabilities: null,
        probeError: null,
      },
      cache: {
        path: "~/.cache/kesha",
        exists: true,
        totalBytes: 2 * 1024 * 1024 * 1024 * 1024,
        components: [
          {
            label: "Huge model",
            path: "~/.cache/kesha/models/huge",
            exists: true,
            sizeBytes: 2 * 1024 * 1024 * 1024 * 1024,
          },
        ],
      },
      optionalComponents: [],
      stats: {
        enabled: false,
        dbPath: "~/stats.sqlite",
        runCount: 0,
        exists: false,
        retentionDays: 90,
      },
      diagnosticLogs: {
        dir: "~/logs",
        activePath: "~/logs/kesha.ndjson",
        statePath: "~/logs/diagnostic-logs.json",
        exists: true,
        activeSizeBytes: 1024,
        rotatedFiles: ["kesha.1.ndjson"],
        totalSizeBytes: 2048,
        mode: "on",
        maxBytes: 10 * 1024 * 1024,
        retain: 5,
      },
      env: {},
    });

    expect(output).toContain("2.0 TB");
    expect(output).toContain("Size: 2.0 KB");
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
