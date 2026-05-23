import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDiagnosticLogLine,
  createDiagnosticLogSession,
  disableDiagnosticLogs,
  enableDiagnosticLogs,
  getDiagnosticLogStatus,
  resetDiagnosticLogs,
  resolveDiagnosticLogPath,
  setDiagnosticLogMode,
  writeDiagnosticEvent,
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
    expect(status.enabled).toBe(true);
    expect(status.mode).toBe("retain-on-failure");
    expect(status.activePath).toBe(join(dir, "kesha.ndjson"));
    expect(status.exists).toBe(false);
    expect(existsSync(status.activePath)).toBe(false);
  });

  test("enable, write, disable, and reset manage local NDJSON logs", () => {
    const enabled = enableDiagnosticLogs();
    expect(enabled.enabled).toBe(true);
    expect(enabled.mode).toBe("on");
    expect(writeDiagnosticEvent("engine.exit", {
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

    const disabled = disableDiagnosticLogs();
    expect(disabled.enabled).toBe(false);
    expect(disabled.mode).toBe("off");
    expect(writeDiagnosticEvent("engine.exit", { command: "transcribe" })).toBe(false);

    enableDiagnosticLogs();
    const reset = resetDiagnosticLogs();
    expect(reset.deleted).toBe(1);
    expect(existsSync(resolveDiagnosticLogPath())).toBe(false);
    expect(getDiagnosticLogStatus().enabled).toBe(true);
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

  test("runtime writer drops unsafe events without writing them", () => {
    enableDiagnosticLogs();
    expect(writeDiagnosticEvent("privacy.test", { path: "/Users/alice/private/audio.wav" })).toBe(false);
    expect(existsSync(resolveDiagnosticLogPath())).toBe(false);
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
      JSON.stringify({ enabled: true, maxBytes: 180, retain: 2 }),
    );

    for (let i = 0; i < 6; i++) {
      expect(writeDiagnosticEvent("rotation.test", { runId: `run-${i}`, bucket: "aaaaaaaaaaaaaaaaaaaa" })).toBe(true);
    }

    const status = getDiagnosticLogStatus();
    expect(status.exists).toBe(true);
    expect(status.rotatedFiles.length).toBeLessThanOrEqual(2);
    expect(status.rotatedFiles).toContain("kesha.1.ndjson");
  });
});
