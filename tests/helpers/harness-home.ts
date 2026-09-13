import { homedir } from "node:os";
import { join } from "node:path";

export interface HarnessHome {
  KESHA_HOME: string;
  KESHA_CACHE_DIR: string;
}

/** Nothing when KESHA_HOME is already set; otherwise the cache pinned to its previous default and a fresh private home (openspec kesha-home). */
export function harnessHome(env: Record<string, string | undefined>, makeHome: () => string, home = homedir()): HarnessHome | undefined {
  if (env.KESHA_HOME) return undefined;
  // An inherited empty KESHA_CACHE_DIR would otherwise slide the cache under the private home and the #741 gate reports the engine missing.
  const cache = env.KESHA_CACHE_DIR || join(home, ".cache", "kesha");
  return { KESHA_CACHE_DIR: cache, KESHA_HOME: makeHome() };
}
