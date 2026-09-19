import { homedir, tmpdir } from "os";
import { posix, win32 } from "path";

export type StatePathSource = "default" | "KESHA_HOME" | "KESHA_CACHE_DIR" | "KESHA_LOG_DIR" | "KESHA_STATS_DB";

export interface StatePath {
  path: string;
  source: StatePathSource;
}

/** The four places Kesha writes, each with the rule that decided it (openspec `state-directories`). */
export interface StatePaths {
  cacheDir: StatePath;
  logDir: StatePath;
  statsDbPath: StatePath;
  mcpAudioDir: StatePath;
}

type Env = Record<string, string | undefined>;

// Anchored once: a core-API caller that chdir()s later must keep one root for the whole process.
const STARTUP_CWD = process.cwd();

function setting(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Precedence per location: its own variable, then `KESHA_HOME`, then the platform default. */
export function resolveStatePaths(
  env: Env = process.env,
  platform: string = process.platform,
  homeDir: string = homedir(),
  tmpDir: string = tmpdir(),
  cwd: string = STARTUP_CWD,
): StatePaths {
  const p = platform === "win32" ? win32 : posix;
  // Absolute values stay verbatim: on win32 `resolve` would prepend a drive to a drive-less `\tmp\x`.
  const anchor = (value: string): string => (p.isAbsolute(value) ? value : p.resolve(cwd, value));
  const home = setting(env, "KESHA_HOME");
  const homeRoot = home === undefined ? undefined : anchor(home);

  const pick = (specific: "KESHA_CACHE_DIR" | "KESHA_LOG_DIR" | "KESHA_STATS_DB" | null, under: string, fallback: string): StatePath => {
    const own = specific === null ? undefined : setting(env, specific);
    if (own !== undefined && specific !== null) return { path: anchor(own), source: specific };
    if (homeRoot !== undefined) return { path: p.join(homeRoot, under), source: "KESHA_HOME" };
    return { path: fallback, source: "default" };
  };

  const defaults = platformDefaults(p, platform, env, homeDir, tmpDir);
  return {
    cacheDir: pick("KESHA_CACHE_DIR", "cache", defaults.cache),
    logDir: pick("KESHA_LOG_DIR", "logs", defaults.logs),
    statsDbPath: pick("KESHA_STATS_DB", "stats.sqlite", defaults.stats),
    mcpAudioDir: pick(null, "mcp-audio", defaults.mcp),
  };
}

function platformDefaults(p: typeof posix | typeof win32, platform: string, env: Env, homeDir: string, tmpDir: string) {
  const cache = p.join(homeDir, ".cache", "kesha");
  const mcp = p.join(tmpDir, "kesha-mcp");
  if (platform === "darwin") {
    return {
      cache,
      mcp,
      logs: p.join(homeDir, "Library", "Logs", "kesha"),
      stats: p.join(homeDir, "Library", "Application Support", "kesha", "stats.sqlite"),
    };
  }
  if (platform === "win32") {
    return {
      cache,
      mcp,
      logs: p.join(setting(env, "LOCALAPPDATA") ?? p.join(homeDir, "AppData", "Local"), "kesha", "logs"),
      stats: p.join(setting(env, "APPDATA") ?? p.join(homeDir, "AppData", "Roaming"), "kesha", "stats.sqlite"),
    };
  }
  return {
    cache,
    mcp,
    logs: p.join(setting(env, "XDG_STATE_HOME") ?? p.join(homeDir, ".local", "state"), "kesha", "logs"),
    stats: p.join(setting(env, "XDG_DATA_HOME") ?? p.join(homeDir, ".local", "share"), "kesha", "stats.sqlite"),
  };
}
