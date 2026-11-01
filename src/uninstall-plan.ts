import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isInsideDir } from "./cache-layout";
import { dirSizeBytes } from "./diagnostic-paths";
import { errorMessage } from "./error-utils";
import { fluidLegacyRootPaths, fluidLegacySubsystemDirs } from "./fluid-roots";
import { resolveStatePaths } from "./state-paths";

interface UninstallEntry {
  path: string;
  label: string;
  bytes: number;
  action: "remove" | "keep";
  reason?: string;
}

export interface UninstallPlan {
  entries: UninstallEntry[];
  /** Removed after the entries, deepest first, and only when nothing is left in them. */
  emptyDirs: string[];
  /** The Engine path in effect, whose install lock uninstall takes. */
  engineBin: string;
  /** Directories that exist but could not be listed, so what Kesha left in them is unknown. */
  unreadable: { path: string; reason: string }[];
}

export interface UninstallPlanOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  homeDir?: string;
  tmpDir?: string;
  cwd?: string;
}

const CACHE_CHILDREN = ["engine", "models", "fluidaudio", "recordings"];
const LOG_FILE = /^kesha(\.\d+)?\.ndjson$|^diagnostic-logs\.json$/;
const MCP_AUDIO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(wav|ogg|flac)$/;
const NOT_KESHA = "not created by Kesha";

/** The uninstall plan: what Kesha created in each state location and FluidAudio root, and what else is there (design.md ownership table). */
export function buildUninstallPlan(options: UninstallPlanOptions = {}): UninstallPlan {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const state = resolveStatePaths(env, platform, homeDir, options.tmpDir ?? tmpdir(), options.cwd ?? process.cwd());
  const cacheDir = state.cacheDir.path;
  const logDir = state.logDir.path;
  const mcpDir = state.mcpAudioDir.path;
  const statsDb = state.statsDbPath.path;
  const engineBin = env.KESHA_ENGINE_BIN || join(cacheDir, "engine", "bin", platform === "win32" ? "kesha-engine.exe" : "kesha-engine");

  const unreadable = new Map<string, string>();
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.set(dir, errorMessage(e));
      return [];
    }
  };

  const removals: { path: string; label: string }[] = [
    ...CACHE_CHILDREN.map((name) => ({ path: join(cacheDir, name), label: `Model cache: ${name}/` })),
    ...list(logDir)
      .filter((name) => LOG_FILE.test(name))
      .map((name) => ({ path: join(logDir, name), label: "Diagnostic log" })),
    ...["", "-wal", "-shm"].map((suffix) => ({ path: `${statsDb}${suffix}`, label: "Stats DB" })),
    ...list(mcpDir)
      .filter((name) => MCP_AUDIO_FILE.test(name))
      .map((name) => ({ path: join(mcpDir, name), label: "MCP audio" })),
    ...fluidLegacySubsystemDirs(homeDir)
      .filter((s) => !isInsideDir(s.path, cacheDir))
      .map((s) => ({ path: s.path, label: `FluidAudio ${s.label}` })),
  ];
  const entries: UninstallEntry[] = [];
  for (const r of removals) {
    if (list(dirname(r.path)).includes(basename(r.path))) entries.push({ ...r, bytes: dirSizeBytes(r.path), action: "remove" });
  }

  // MCP audio has no variable of its own, so under KESHA_HOME its parent is that root.
  const keshaHome = state.mcpAudioDir.source === "KESHA_HOME" ? dirname(mcpDir) : undefined;
  const statsParent = state.statsDbPath.source === "KESHA_STATS_DB" ? undefined : dirname(statsDb);
  // Outside darwin the default log directory is `<state>/kesha/logs`.
  const logParent = state.logDir.source === "default" && platform !== "darwin" ? dirname(logDir) : undefined;
  const stateDirs = [cacheDir, logDir, mcpDir, statsParent, logParent, keshaHome].filter((d): d is string => d !== undefined);
  const claimed = new Set([...removals.map((r) => r.path), ...stateDirs]);

  const keep = (path: string, reason = NOT_KESHA): void => {
    if (entries.some((e) => e.path === path)) return;
    entries.push({ path, label: "Not Kesha's", bytes: dirSizeBytes(path), action: "keep", reason });
  };
  const scan = (dir: string, descend: boolean): void => {
    for (const name of list(dir)) {
      const path = join(dir, name);
      if (claimed.has(path)) continue;
      if ([...claimed].some((c) => isInsideDir(c, path))) {
        if (descend) scan(path, true);
        continue;
      }
      keep(path);
    }
  };
  for (const dir of new Set(stateDirs)) scan(dir, false);
  for (const root of fluidLegacyRootPaths(homeDir)) if (!isInsideDir(root, cacheDir)) scan(root, true);
  if (env.KESHA_ENGINE_BIN && !isInsideDir(engineBin, cacheDir) && list(dirname(engineBin)).includes(basename(engineBin))) {
    keep(engineBin, "KESHA_ENGINE_BIN outside the Model cache");
  }

  const emptyDirs = [...new Set(stateDirs)].sort((a, b) => b.length - a.length);
  return { entries, emptyDirs, engineBin, unreadable: [...unreadable].map(([path, reason]) => ({ path, reason })) };
}
