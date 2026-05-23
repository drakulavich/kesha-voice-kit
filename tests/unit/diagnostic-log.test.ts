import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDiagnosticLogLine,
  createDiagnosticLogSession,
  getDiagnosticLogStatus,
  resetDiagnosticLogs,
  resolveDiagnosticLogPath,
  setDiagnosticLogMode,
  type DiagnosticLogFields,
} from "../../src/diagnostic-log";

let dir = "";
let previousLogDir: string | undefined;

beforeEach(() => {
  previousLogDir = process.env.KESHA_LOG_DIR;
  dir = mkdtempSync(join(tmpdir(), "kesha-diagnostic-log-test-"));
  process.env.KESHA_LOG_DIR = dir;
});

afterEach(() => {
  if (previousLogDir === undefined) delete process.env.KESHA_LOG_DIR;
  else process.env.KESHA_LOG_DIR = previousLogDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("diagnostic log storage", () => {
  test("defaults to retain-on-failure without creating files", () => {
    const status = getDiagnosticLogStatus();
    expect(status.mode).toBe("retain-on-failure");
    expect(status.activePath).toBe(join(dir, "kesha.ndjson"));
    expect(status.exists).toBe(false);
    expect(existsSync(status.activePath)).toBe(false);
  });

  test("enable, write, disable, and reset manage local NDJSON logs", () => {
    const enabled = setDiagnosticLogMode("on");
    expect(enabled.mode).toBe("on");
    const session = createDiagnosticLogSession();
    expect(session.event("engine.exit", {
      command: "transcribe",
      exitCode: 0,
      durationMs: 42,
      backend: "coreml",
    })).toBe(true);

    const line = readFileSync(resolveDiagnosticLogPath(), "utf8").trim();
    const payload = JSON.parse(line);
    expect(payload.event).toBe("engine.exit");
    expect(payload.command).toBe("transcribe");
    expect(payload.exitCode).toBe(0);
    expect(payload.backend).toBe("coreml");

    const disabled = setDiagnosticLogMode("off");
    expect(disabled.mode).toBe("off");
    expect(createDiagnosticLogSession().event("engine.exit", { command: "transcribe" })).toBe(false);

    setDiagnosticLogMode("on");
    const reset = resetDiagnosticLogs();
    expect(reset.deleted).toBe(1);
    expect(existsSync(resolveDiagnosticLogPath())).toBe(false);
    expect(getDiagnosticLogStatus().mode).toBe("on");
  });

  test("rejects fields that could carry user content", () => {
    const unsafeValues: DiagnosticLogFields[] = [
      { path: "/Users/alice/private/audio.wav" },
      { filename: "therapy-session.m4a" },
      { binary: "/opt/kesha/bin/kesha-engine" },
      { binary: "/usr/local/bin/kesha-engine" },
      { binary: "/Applications/Kesha.app" },
      { binary: "relative/private/audio.wav" },
      { binary: "..\\private\\audio.wav" },
      { endpoint: "https://api.example.com/v1?token=secret" },
      { endpoint: "api.example.com" },
      { text: "hello private transcript" },
      { message: "arbitrary error prose" },
      { transcript: "private words" },
      { stdout: "{\"text\":\"hello\"}" },
      { stderr: "raw engine output" },
      { raw: "anything" },
      { token: "secret" },
      { format: "/Users/alice/private/audio.wav" },
      { format: "therapy-session.m4a" },
      { format: "meeting.aac" },
      { format: "meeting.opus" },
      { format: "meeting.wma" },
      { format: "meeting.webm" },
      { format: "meeting.mp4" },
      { event: "other.event" },
      { level: "debug" },
      { app_version: "1.2.3" },
      { pid: 123 },
      { ts: null },
    ];

    for (const fields of unsafeValues) {
      expect(() => buildDiagnosticLogLine("privacy.test", fields)).toThrow();
    }
  });

  test("allows coarse content-free audio shape fields", () => {
    const line = buildDiagnosticLogLine("privacy.shape", {
      command: "transcribe",
      format: ".ogg",
      sizeBucket: "1-10MB",
      durationBucket: "0-30s",
      channels: 1,
    });
    const payload = JSON.parse(new TextDecoder().decode(line));
    expect(payload.format).toBe(".ogg");
    expect(payload.durationBucket).toBe("0-30s");
  });

  test("retain-on-failure session buffers successful runs and writes failed runs", () => {
    setDiagnosticLogMode("retain-on-failure");

    const success = createDiagnosticLogSession();
    expect(success.event("command.start", { command: "transcribe", runId: "ok-1" })).toBe(true);
    expect(success.finish("success")).toBe(false);
    expect(existsSync(resolveDiagnosticLogPath())).toBe(false);

    const failed = createDiagnosticLogSession();
    expect(failed.event("command.start", { command: "transcribe", runId: "fail-1" })).toBe(true);
    expect(failed.event("engine.exit", { command: "transcribe", exitCode: 42 })).toBe(true);
    expect(failed.finish("failed")).toBe(true);

    const lines = readFileSync(resolveDiagnosticLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("command.start");
    expect(JSON.parse(lines[1]).exitCode).toBe(42);
  });

  test("retain-on-failure session finish is terminal", () => {
    setDiagnosticLogMode("retain-on-failure");

    const failed = createDiagnosticLogSession();
    expect(failed.event("command.start", { command: "transcribe", runId: "fail-once" })).toBe(true);
    expect(failed.finish("failed")).toBe(true);
    expect(failed.finish("failed")).toBe(false);
    expect(failed.event("engine.exit", { command: "transcribe", exitCode: 1 })).toBe(false);

    const lines = readFileSync(resolveDiagnosticLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).runId).toBe("fail-once");

    const success = createDiagnosticLogSession();
    expect(success.event("command.start", { command: "transcribe", runId: "success-first" })).toBe(true);
    expect(success.finish("success")).toBe(false);
    expect(success.finish("failed")).toBe(false);

    const afterSuccess = readFileSync(resolveDiagnosticLogPath(), "utf8").trim().split("\n");
    expect(afterSuccess).toHaveLength(1);
  });

  test("retain-on-failure flush uses current log directory", () => {
    setDiagnosticLogMode("retain-on-failure");
    const session = createDiagnosticLogSession();
    expect(session.event("command.start", { command: "transcribe", runId: "move-1" })).toBe(true);

    const nextDir = mkdtempSync(join(tmpdir(), "kesha-diagnostic-log-moved-"));
    try {
      process.env.KESHA_LOG_DIR = nextDir;
      expect(session.finish("failed")).toBe(true);
      expect(existsSync(join(nextDir, "kesha.ndjson"))).toBe(true);
      expect(existsSync(join(dir, "kesha.ndjson"))).toBe(false);
    } finally {
      rmSync(nextDir, { recursive: true, force: true });
      process.env.KESHA_LOG_DIR = dir;
    }
  });

  test("rotates active log by size and keeps bounded history", () => {
    writeFileSync(
      join(dir, "diagnostic-logs.json"),
      JSON.stringify({ mode: "on", maxBytes: 180, retain: 2 }),
    );

    for (let i = 0; i < 6; i++) {
      expect(createDiagnosticLogSession().event("rotation.test", {
        runId: `run-${i}`,
        bucket: "aaaaaaaaaaaaaaaaaaaa",
      })).toBe(true);
    }

    const status = getDiagnosticLogStatus();
    expect(status.exists).toBe(true);
    expect(status.rotatedFiles.length).toBeLessThanOrEqual(2);
    expect(status.rotatedFiles).toContain("kesha.1.ndjson");
  });
});
