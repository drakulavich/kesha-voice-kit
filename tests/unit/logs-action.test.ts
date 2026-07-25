import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runLogsAction } from "../../src/cli/logs";

describe("runLogsAction", () => {
  let dir: string;
  const savedLogDir = process.env.KESHA_LOG_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kesha-logs-action-"));
    process.env.KESHA_LOG_DIR = dir;
  });

  afterEach(() => {
    if (savedLogDir === undefined) delete process.env.KESHA_LOG_DIR;
    else process.env.KESHA_LOG_DIR = savedLogDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function texts(result: ReturnType<typeof runLogsAction>): string[] {
    if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
    return result.messages.map((m) => m.text);
  }

  function expectRejected(args: Parameters<typeof runLogsAction>[0]) {
    const result = runLogsAction(args);
    if (result.ok) throw new Error("expected the action to be rejected");
    return result;
  }

  test("defaults to status when no action is given", () => {
    expect(texts(runLogsAction({}))[0]).toContain("Kesha diagnostic logs:");
  });

  test("enable reports success, mode, path, and rotation", () => {
    const result = runLogsAction({ action: "enable" });
    if (!result.ok) throw new Error(result.error);
    expect(result.messages[0]).toEqual({ level: "success", text: "Kesha diagnostic logs enabled" });
    const lines = texts(result);
    expect(lines.some((l) => l === "Mode: on")).toBe(true);
    expect(lines.some((l) => l.startsWith("Rotation: "))).toBe(true);
  });

  test("disable reports the off mode", () => {
    runLogsAction({ action: "enable" });
    const lines = texts(runLogsAction({ action: "disable" }));
    expect(lines[0]).toBe("Kesha diagnostic logs disabled");
    expect(lines.some((l) => l === "Mode: off")).toBe(true);
  });

  test("status --json emits parseable JSON on stdout instead of log lines", () => {
    const result = runLogsAction({ action: "status", json: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.messages).toEqual([]);
    expect(JSON.parse(result.stdout ?? "").mode).toBeDefined();
  });

  test("--json is rejected for any action other than status", () => {
    expect(expectRejected({ action: "enable", json: true }).error).toBe("usage: kesha logs status --json");
  });

  test("mode without a value reports the current mode", () => {
    expect(texts(runLogsAction({ action: "mode" }))[0]).toContain("Kesha diagnostic log mode:");
  });

  test("mode accepts the three documented modes", () => {
    for (const mode of ["on", "off", "retain-on-failure"]) {
      expect(texts(runLogsAction({ action: "mode", value: mode }))[0]).toBe(
        `Kesha diagnostic log mode set to ${mode}`,
      );
    }
  });

  test("mode rejects an unknown value with a usage hint", () => {
    expect(expectRejected({ action: "mode", value: "verbose" }).error).toBe(
      "usage: kesha logs mode <off|on|retain-on-failure>",
    );
  });

  test("path reports the active log path", () => {
    expect(texts(runLogsAction({ action: "path" }))[0]).toContain(dir);
  });

  test("reset reports how much was deleted", () => {
    expect(texts(runLogsAction({ action: "reset" }))[0]).toContain("Kesha diagnostic logs reset:");
  });

  test("an unknown action is rejected with the supported list as a hint", () => {
    const result = expectRejected({ action: "frobnicate" });
    expect(result.error).toBe("unknown logs action 'frobnicate'");
    expect(result.hint).toContain("enable, disable, mode, status, path, reset");
  });
});
