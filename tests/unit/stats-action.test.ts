import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runStatsAction } from "../../src/cli/stats";
import { enableStats } from "../../src/stats";

describe("runStatsAction", () => {
  let dir: string;
  const savedStatsDb = process.env.KESHA_STATS_DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kesha-stats-action-"));
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
  });

  afterEach(() => {
    if (savedStatsDb === undefined) delete process.env.KESHA_STATS_DB;
    else process.env.KESHA_STATS_DB = savedStatsDb;
    rmSync(dir, { recursive: true, force: true });
  });

  function texts(result: ReturnType<typeof runStatsAction>): string[] {
    if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
    return result.messages.map((m) => m.text);
  }

  function expectRejected(args: Parameters<typeof runStatsAction>[0]) {
    const result = runStatsAction(args);
    if (result.ok) throw new Error("expected the action to be rejected");
    return result;
  }

  test("defaults to status when no action is given", () => {
    const lines = texts(runStatsAction({}));
    expect(lines[0]).toBe("Kesha Stats: disabled");
    expect(lines.some((l) => l.startsWith("Runs: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("Retention: "))).toBe(true);
  });

  test("enable reports success and the database path", () => {
    const result = runStatsAction({ action: "enable" });
    if (!result.ok) throw new Error(result.error);
    expect(result.messages[0]).toEqual({ level: "success", text: "Kesha Stats enabled" });
    expect(texts(result).some((l) => l.includes(dir))).toBe(true);
    expect(texts(runStatsAction({ action: "status" }))[0]).toBe("Kesha Stats: enabled");
  });

  test("disable turns a previously enabled database off", () => {
    enableStats();
    expect(texts(runStatsAction({ action: "disable" }))[0]).toBe("Kesha Stats disabled");
    expect(texts(runStatsAction({ action: "status" }))[0]).toBe("Kesha Stats: disabled");
  });

  test("export writes the payload to stdout rather than the log", () => {
    enableStats();
    const result = runStatsAction({ action: "export", format: "json" });
    if (!result.ok) throw new Error(result.error);
    expect(result.messages).toEqual([]);
    expect(() => JSON.parse(result.stdout ?? "")).not.toThrow();
  });

  test("export accepts the format as a positional value", () => {
    enableStats();
    const result = runStatsAction({ action: "export", value: "csv" });
    if (!result.ok) throw new Error(result.error);
    expect(result.stdout).toBeDefined();
  });

  test("export rejects an unknown format with a usage hint", () => {
    expect(expectRejected({ action: "export", format: "xml" }).error).toBe(
      "usage: kesha stats export --format json|csv",
    );
  });

  test("retention without a value reports the current setting", () => {
    enableStats();
    expect(texts(runStatsAction({ action: "retention" }))[0]).toContain("retention:");
  });

  test("retention accepts a day count and 'off'", () => {
    enableStats();
    expect(texts(runStatsAction({ action: "retention", value: "30" }))[0]).toContain("30 day(s)");
    expect(texts(runStatsAction({ action: "retention", value: "off" }))[0]).toContain("off");
  });

  test("retention rejects a non-positive or fractional day count", () => {
    enableStats();
    const usage = "usage: kesha stats retention <days|off>";
    expect(expectRejected({ action: "retention", value: "0" }).error).toBe(usage);
    expect(expectRejected({ action: "retention", value: "1.5" }).error).toBe(usage);
    expect(expectRejected({ action: "retention", value: "soon" }).error).toBe(usage);
  });

  test("an unknown action is rejected with the supported list as a hint", () => {
    const result = expectRejected({ action: "frobnicate" });
    expect(result.error).toBe("unknown stats action 'frobnicate'");
    expect(result.hint).toContain("enable, disable, status, week, errors, export, reset, vacuum, retention");
  });

  test("week and errors render without an existing database", () => {
    expect(texts(runStatsAction({ action: "week" })).length).toBeGreaterThan(0);
    expect(texts(runStatsAction({ action: "errors" })).length).toBeGreaterThan(0);
  });

  test("reset and vacuum report what they changed", () => {
    enableStats();
    expect(texts(runStatsAction({ action: "reset" }))[0]).toContain("Kesha Stats reset:");
    expect(texts(runStatsAction({ action: "vacuum" }))[0]).toContain("Kesha Stats vacuumed:");
  });
});
