import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDiagnosticLogLine,
  createDiagnosticLogSession,
  getDiagnosticLogStatus,
  humanBytes,
  readDiagnosticLogTail,
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

  test("reads a bounded active log tail from line boundaries", () => {
    writeFileSync(
      resolveDiagnosticLogPath(),
      [
        JSON.stringify({ event: "command.start", runId: "first" }),
        JSON.stringify({ event: "engine.exit", runId: "middle" }),
        JSON.stringify({ event: "command.finish", runId: "last" }),
        "",
      ].join("\n"),
    );

    const tail = readDiagnosticLogTail(90);
    expect(tail?.truncated).toBe(true);
    expect(tail?.contents).not.toContain("first");
    expect(tail?.contents).toContain("middle");
    expect(tail?.contents).toContain("last");
    for (const line of tail?.contents.trim().split("\n") ?? []) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("humanBytes", () => {
  test("stays in bytes below the first threshold", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
  });

  test("switches unit exactly at each 1024 boundary", () => {
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
    expect(humanBytes(1024 ** 3)).toBe("1.0 GB");
    expect(humanBytes(1024 ** 4)).toBe("1.0 TB");
  });

  // A decimal on a four-digit number is noise; below ten it is the whole signal.
  test("drops the decimal once the value reaches ten", () => {
    expect(humanBytes(9.5 * 1024)).toBe("9.5 KB");
    expect(humanBytes(10 * 1024)).toBe("10 KB");
    expect(humanBytes(512 * 1024)).toBe("512 KB");
  });

  test("stops at the largest unit it knows rather than inventing one", () => {
    expect(humanBytes(5 * 1024 ** 5)).toBe("5120 TB");
  });
});

describe("a corrupt state file cannot break logging", () => {
  const defaults = { maxBytes: 10 * 1024 * 1024, retain: 5 };

  for (const [shape, written] of [
    ["a zero limit", { mode: "on", maxBytes: 0, retain: 0 }],
    ["a negative limit", { mode: "on", maxBytes: -1, retain: -5 }],
    ["a fractional limit", { mode: "on", maxBytes: 1.5, retain: 2.5 }],
    ["a stringified limit", { mode: "on", maxBytes: "1048576", retain: "3" }],
    ["missing limits", { mode: "on" }],
  ] as const) {
    test(`${shape} falls back to the defaults`, () => {
      writeFileSync(join(dir, "diagnostic-logs.json"), JSON.stringify(written));

      const status = getDiagnosticLogStatus();

      expect(status.mode).toBe("on");
      expect(status.maxBytes).toBe(defaults.maxBytes);
      expect(status.retain).toBe(defaults.retain);
    });
  }

  test("an unreadable state file leaves the mode at its default", () => {
    writeFileSync(join(dir, "diagnostic-logs.json"), "{ not json");

    const status = getDiagnosticLogStatus();

    expect(status.mode).toBe("retain-on-failure");
    expect(status.maxBytes).toBe(defaults.maxBytes);
  });
});

describe("rotation keeps the newest history and drops the oldest", () => {
  function writeEvents(count: number, prefix: string) {
    for (let i = 0; i < count; i++) {
      expect(
        createDiagnosticLogSession().event("rotation.test", {
          runId: `${prefix}-${i}`,
          bucket: "aaaaaaaaaaaaaaaaaaaa",
        }),
      ).toBe(true);
    }
  }

  test("the history is exactly `retain` files, newest first", () => {
    writeFileSync(
      join(dir, "diagnostic-logs.json"),
      JSON.stringify({ mode: "on", maxBytes: 180, retain: 2 }),
    );

    writeEvents(3, "older");
    writeEvents(3, "newer");

    const status = getDiagnosticLogStatus();
    expect(status.rotatedFiles).toEqual(["kesha.1.ndjson", "kesha.2.ndjson"]);
    expect(existsSync(join(dir, "kesha.3.ndjson"))).toBe(false);

    const first = readFileSync(join(dir, "kesha.1.ndjson"), "utf8");
    const second = readFileSync(join(dir, "kesha.2.ndjson"), "utf8");
    expect(first).toContain("newer-");
    expect(second).not.toContain("newer-2");
  });
});

describe("the tail says whether it dropped anything", () => {
  test("a log smaller than the window comes back whole and untruncated", () => {
    const body = `${JSON.stringify({ event: "command.start", runId: "only" })}\n`;
    writeFileSync(resolveDiagnosticLogPath(), body);

    const tail = readDiagnosticLogTail(64 * 1024);

    expect(tail?.truncated).toBe(false);
    expect(tail?.contents).toBe(body);
    expect(tail?.sizeBytes).toBe(body.length);
  });

  test("an absent log is null rather than an empty tail", () => {
    expect(readDiagnosticLogTail()).toBeNull();
  });
});

describe("the log inventory is the log's own files, in rotation order", () => {
  test("double-digit rotations sort after single-digit ones", () => {
    for (const i of [1, 2, 10, 11, 3]) {
      writeFileSync(join(dir, `kesha.${i}.ndjson`), `rotation ${i}\n`);
    }

    expect(getDiagnosticLogStatus().rotatedFiles).toEqual([
      "kesha.1.ndjson",
      "kesha.2.ndjson",
      "kesha.3.ndjson",
      "kesha.10.ndjson",
      "kesha.11.ndjson",
    ]);
  });

  test("neighbours in the log directory are not counted as history", () => {
    writeFileSync(join(dir, "kesha.1.ndjson"), "rotation\n");
    for (const stranger of ["kesha.ndjson", "kesha.x.ndjson", "kesha.1.ndjson.bak", "notes.txt"]) {
      writeFileSync(join(dir, stranger), "not history\n");
    }

    expect(getDiagnosticLogStatus().rotatedFiles).toEqual(["kesha.1.ndjson"]);
  });

  test("the reported total covers the rotated files too", () => {
    writeFileSync(resolveDiagnosticLogPath(), "a".repeat(10));
    writeFileSync(join(dir, "kesha.1.ndjson"), "b".repeat(20));
    writeFileSync(join(dir, "kesha.2.ndjson"), "c".repeat(30));

    const status = getDiagnosticLogStatus();
    expect(status.activeSizeBytes).toBe(10);
    expect(status.totalSizeBytes).toBe(60);
  });
});

describe("event names are constrained like field names", () => {
  for (const event of ["Command.Start", "command..start", "1command", "command.start.", "command start", ""]) {
    test(`"${event}" is refused`, () => {
      expect(() => buildDiagnosticLogLine(event, {})).toThrow("unsafe diagnostic event name");
    });
  }

  test("a dotted lowercase name is accepted", () => {
    const payload = JSON.parse(new TextDecoder().decode(buildDiagnosticLogLine("engine.exit2", {})));
    expect(payload.event).toBe("engine.exit2");
  });
});

describe("a buffered session only spends the disk it has to", () => {
  test("a failed run with nothing buffered writes no file", () => {
    setDiagnosticLogMode("retain-on-failure");
    resetDiagnosticLogs();

    expect(createDiagnosticLogSession().finish("failed")).toBe(false);
    expect(existsSync(resolveDiagnosticLogPath())).toBe(false);
  });

  test("a successful run discards its buffer without writing", () => {
    setDiagnosticLogMode("retain-on-failure");
    resetDiagnosticLogs();

    const session = createDiagnosticLogSession();
    expect(session.event("command.start", { command: "transcribe" })).toBe(true);
    expect(session.finish("success")).toBe(false);
    expect(existsSync(resolveDiagnosticLogPath())).toBe(false);
  });

  test("turning logging off mid-run drops the buffer instead of flushing it", () => {
    setDiagnosticLogMode("retain-on-failure");
    resetDiagnosticLogs();

    const session = createDiagnosticLogSession();
    expect(session.event("command.start", { command: "transcribe" })).toBe(true);
    setDiagnosticLogMode("off");

    expect(session.finish("failed")).toBe(false);
    expect(existsSync(resolveDiagnosticLogPath())).toBe(false);
  });
});
