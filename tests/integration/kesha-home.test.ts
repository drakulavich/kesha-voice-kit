import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { writeTranscribingEngine } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";
import { runCliScenario } from "./cli-scenario";

type StatusPathsJson = Record<"cache" | "logs" | "stats" | "mcpAudio", { path: string; source: string }>;

const SPECIFIC = ["KESHA_CACHE_DIR", "KESHA_LOG_DIR", "KESHA_STATS_DB"] as const;
const scenarioTest = process.platform === "win32" ? test.skip : test;

// One variable has to be enough, so the three specific ones are removed from the inherited env.
describe("KESHA_HOME isolates a whole run (openspec state-directories)", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of SPECIFIC) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  scenarioTest("logs, stats and the reported paths all land under it", async () => {
    const dir = tempDir("kesha-home-scenario-");
    const home = join(dir, "state");
    const enginePath = writeTranscribingEngine(
      "kesha-home-engine-",
      ["transcribe"],
      `  printf '%s\\n' '{"text":"ok","segments":[{"start":0,"end":1,"text":"ok"}]}'`,
    );
    const audio = join(dir, "note.ogg");
    writeFileSync(audio, "OggS");
    const env = { HOME: dir, KESHA_HOME: home, KESHA_ENGINE_BIN: enginePath };

    const status = await runCliScenario(["status", "--json"], { env });
    expect(status.exitCode).toBe(0);
    const paths = JSON.parse(status.stdout).paths as StatusPathsJson;
    expect(paths.cache).toEqual({ path: join(home, "cache"), source: "KESHA_HOME" });
    expect(paths.logs).toEqual({ path: join(home, "logs"), source: "KESHA_HOME" });
    expect(paths.stats).toEqual({ path: join(home, "stats.sqlite"), source: "KESHA_HOME" });
    expect(paths.mcpAudio).toEqual({ path: join(home, "mcp-audio"), source: "KESHA_HOME" });

    expect((await runCliScenario(["stats", "enable"], { env })).exitCode).toBe(0);
    expect((await runCliScenario(["logs", "mode", "on"], { env })).exitCode).toBe(0);
    const statsBefore = statSync(join(home, "stats.sqlite")).size;

    const run = await runCliScenario([audio], { env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("ok");

    expect(existsSync(join(home, "logs", "kesha.ndjson"))).toBe(true);
    expect(statSync(join(home, "stats.sqlite")).size).toBeGreaterThanOrEqual(statsBefore);
    const week = await runCliScenario(["stats", "week"], { env });
    expect(week.exitCode).toBe(0);
    expect(week.stderr + week.stdout).toMatch(/Runs:\s*1\b/);

    const entries = readdirSync(home).filter((name) => !name.startsWith("stats.sqlite-"));
    expect(entries.sort()).toEqual(["logs", "stats.sqlite"]);
  }, 60_000);

  scenarioTest("a specific variable keeps its own location out of the umbrella", async () => {
    const dir = tempDir("kesha-home-specific-");
    const home = join(dir, "state");
    const env = { HOME: dir, KESHA_HOME: home, KESHA_LOG_DIR: join(dir, "elsewhere") };

    const res = await runCliScenario(["logs", "path"], { env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout + res.stderr).toContain(join(dir, "elsewhere", "kesha.ndjson"));

    const status = await runCliScenario(["status", "--json"], { env });
    const paths = JSON.parse(status.stdout).paths as StatusPathsJson;
    expect(paths.logs.source).toBe("KESHA_LOG_DIR");
    expect(paths.stats.source).toBe("KESHA_HOME");
  }, 30_000);
});
