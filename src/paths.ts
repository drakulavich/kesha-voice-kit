import { homedir } from "os";
import { join } from "path";

export function keshaCacheDir(): string {
  return process.env.KESHA_CACHE_DIR ?? join(homedir(), ".cache", "kesha");
}

/** The `.exe` suffix is a platform fact, not a per-target one: an extensionless PE is not reliably spawnable. */
export function defaultEngineBinPath(platform = process.platform): string {
  const basename = platform === "win32" ? "kesha-engine.exe" : "kesha-engine";
  return join(keshaCacheDir(), "engine", "bin", basename);
}
