import { homedir } from "os";
import { join } from "path";

export function keshaCacheDir(): string {
  return process.env.KESHA_CACHE_DIR ?? join(homedir(), ".cache", "kesha");
}

/** Windows needs the `.exe` suffix: the release asset is a PE, and an extensionless copy is not reliably spawnable. */
export function defaultEngineBinPath(platform = process.platform): string {
  const basename = platform === "win32" ? "kesha-engine.exe" : "kesha-engine";
  return join(keshaCacheDir(), "engine", "bin", basename);
}
