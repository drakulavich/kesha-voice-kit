import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveStatePaths, type StatePathSource } from "../../src/state-paths";

const HOME = { darwin: "/Users/ira", linux: "/home/ira", win32: "C:\\Users\\ira" } as const;
const TMP = { darwin: "/var/tmp", linux: "/tmp", win32: "C:\\Temp" } as const;

type Platform = keyof typeof HOME;

function resolve(platform: Platform, env: Record<string, string | undefined>, cwd = "/work") {
  return resolveStatePaths(env, platform, HOME[platform], TMP[platform], cwd);
}

const sep = (platform: Platform) => (platform === "win32" ? "\\" : "/");
const j = (platform: Platform, ...parts: string[]) => parts.join(sep(platform));

const DEFAULTS: Record<Platform, { cache: string; logs: string; stats: string; mcp: string }> = {
  darwin: {
    cache: "/Users/ira/.cache/kesha",
    logs: "/Users/ira/Library/Logs/kesha",
    stats: "/Users/ira/Library/Application Support/kesha/stats.sqlite",
    mcp: "/var/tmp/kesha-mcp",
  },
  linux: {
    cache: "/home/ira/.cache/kesha",
    logs: "/home/ira/.local/state/kesha/logs",
    stats: "/home/ira/.local/share/kesha/stats.sqlite",
    mcp: "/tmp/kesha-mcp",
  },
  win32: {
    cache: "C:\\Users\\ira\\.cache\\kesha",
    logs: "C:\\Users\\ira\\AppData\\Local\\kesha\\logs",
    stats: "C:\\Users\\ira\\AppData\\Roaming\\kesha\\stats.sqlite",
    mcp: "C:\\Temp\\kesha-mcp",
  },
};

function sources(paths: ReturnType<typeof resolve>): Record<string, StatePathSource> {
  return {
    cache: paths.cacheDir.source,
    logs: paths.logDir.source,
    stats: paths.statsDbPath.source,
    mcp: paths.mcpAudioDir.source,
  };
}

describe("resolveStatePaths", () => {
  const platforms: Platform[] = ["darwin", "linux", "win32"];

  test.each(platforms)("%s: nothing set resolves to the platform defaults", (platform) => {
    const p = resolve(platform, {});
    expect(p.cacheDir.path).toBe(DEFAULTS[platform].cache);
    expect(p.logDir.path).toBe(DEFAULTS[platform].logs);
    expect(p.statsDbPath.path).toBe(DEFAULTS[platform].stats);
    expect(p.mcpAudioDir.path).toBe(DEFAULTS[platform].mcp);
    expect(sources(p)).toEqual({ cache: "default", logs: "default", stats: "default", mcp: "default" });
  });

  test.each(platforms)("%s: KESHA_HOME alone roots all four with one layout", (platform) => {
    const home = j(platform, HOME[platform], "kesha-home");
    const p = resolve(platform, { KESHA_HOME: home });
    expect(p.cacheDir.path).toBe(j(platform, home, "cache"));
    expect(p.logDir.path).toBe(j(platform, home, "logs"));
    expect(p.statsDbPath.path).toBe(j(platform, home, "stats.sqlite"));
    expect(p.mcpAudioDir.path).toBe(j(platform, home, "mcp-audio"));
    expect(sources(p)).toEqual({
      cache: "KESHA_HOME",
      logs: "KESHA_HOME",
      stats: "KESHA_HOME",
      mcp: "KESHA_HOME",
    });
  });

  const combos = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({
    cache: Boolean(bits & 1),
    logs: Boolean(bits & 2),
    stats: Boolean(bits & 4),
  }));

  test.each(combos)("specific variables outrank KESHA_HOME: %j", ({ cache, logs, stats }) => {
    const env: Record<string, string> = { KESHA_HOME: "/tmp/ci" };
    if (cache) env.KESHA_CACHE_DIR = "/mnt/models";
    if (logs) env.KESHA_LOG_DIR = "/var/log/kesha";
    if (stats) env.KESHA_STATS_DB = "/srv/kesha/metrics.sqlite";
    const p = resolve("linux", env);

    expect(p.cacheDir).toEqual(
      cache ? { path: "/mnt/models", source: "KESHA_CACHE_DIR" } : { path: "/tmp/ci/cache", source: "KESHA_HOME" },
    );
    expect(p.logDir).toEqual(
      logs ? { path: "/var/log/kesha", source: "KESHA_LOG_DIR" } : { path: "/tmp/ci/logs", source: "KESHA_HOME" },
    );
    expect(p.statsDbPath).toEqual(
      stats
        ? { path: "/srv/kesha/metrics.sqlite", source: "KESHA_STATS_DB" }
        : { path: "/tmp/ci/stats.sqlite", source: "KESHA_HOME" },
    );
    expect(p.mcpAudioDir).toEqual({ path: "/tmp/ci/mcp-audio", source: "KESHA_HOME" });
  });

  test("specific variables without KESHA_HOME keep their meaning", () => {
    const p = resolve("darwin", {
      KESHA_CACHE_DIR: "/mnt/models",
      KESHA_LOG_DIR: "/var/log/kesha",
      KESHA_STATS_DB: "/srv/kesha/metrics.sqlite",
    });
    expect(p.cacheDir).toEqual({ path: "/mnt/models", source: "KESHA_CACHE_DIR" });
    expect(p.logDir).toEqual({ path: "/var/log/kesha", source: "KESHA_LOG_DIR" });
    expect(p.statsDbPath).toEqual({ path: "/srv/kesha/metrics.sqlite", source: "KESHA_STATS_DB" });
    expect(p.mcpAudioDir).toEqual({ path: DEFAULTS.darwin.mcp, source: "default" });
  });

  test("an empty variable counts as unset, for the umbrella and for each specific one", () => {
    const p = resolve("darwin", { KESHA_HOME: "", KESHA_CACHE_DIR: "", KESHA_LOG_DIR: "", KESHA_STATS_DB: "" });
    expect(p).toEqual(resolve("darwin", {}));
  });

  test("whitespace inside a path is part of the path, never trimmed away", () => {
    const p = resolve("linux", { KESHA_CACHE_DIR: "/mnt/models ", KESHA_LOG_DIR: " logs" }, "/work");
    expect(p.cacheDir.path).toBe("/mnt/models ");
    expect(p.logDir.path).toBe("/work/ logs");
  });

  test("a relative value is anchored to the working directory once", () => {
    const p = resolve("linux", { KESHA_HOME: "./state", KESHA_LOG_DIR: "logs/here" }, "/work/job");
    expect(p.cacheDir.path).toBe("/work/job/state/cache");
    expect(p.logDir.path).toBe("/work/job/logs/here");
    expect(p.statsDbPath.path).toBe("/work/job/state/stats.sqlite");
  });

  test("the working directory is anchored once per process, so a later chdir() keeps one root", () => {
    const startedIn = process.cwd();
    const env = { KESHA_HOME: "rel-state", KESHA_CACHE_DIR: "rel-cache" };
    const before = resolveStatePaths(env, "linux", "/home/ira", "/tmp");
    try {
      process.chdir(mkdtempSync(join(tmpdir(), "kesha-chdir-")));
      expect(resolveStatePaths(env, "linux", "/home/ira", "/tmp")).toEqual(before);
    } finally {
      process.chdir(startedIn);
    }
    expect(before.cacheDir.path).toBe(join(startedIn, "rel-cache"));
    expect(before.logDir.path).toBe(join(startedIn, "rel-state", "logs"));
  });

  test("an absolute value is kept verbatim, drive-less Windows paths included", () => {
    const p = resolve("win32", { KESHA_CACHE_DIR: "\\tmp\\kesha-cache", KESHA_HOME: "/tmp/kesha-home" }, "D:\\work");
    expect(p.cacheDir.path).toBe("\\tmp\\kesha-cache");
    expect(p.logDir.path).toBe("\\tmp\\kesha-home\\logs");
  });

  test("XDG and Windows base variables still shape the defaults", () => {
    const linux = resolve("linux", { XDG_STATE_HOME: "/xdg/state", XDG_DATA_HOME: "/xdg/data" });
    expect(linux.logDir.path).toBe("/xdg/state/kesha/logs");
    expect(linux.statsDbPath.path).toBe("/xdg/data/kesha/stats.sqlite");

    const win = resolve("win32", { LOCALAPPDATA: "D:\\Local", APPDATA: "D:\\Roaming" });
    expect(win.logDir.path).toBe("D:\\Local\\kesha\\logs");
    expect(win.statsDbPath.path).toBe("D:\\Roaming\\kesha\\stats.sqlite");
  });

  test("KESHA_HOME beats the XDG bases, which apply only to the platform default", () => {
    const p = resolve("linux", { KESHA_HOME: "/tmp/ci", XDG_STATE_HOME: "/xdg/state" });
    expect(p.logDir).toEqual({ path: "/tmp/ci/logs", source: "KESHA_HOME" });
  });
});
