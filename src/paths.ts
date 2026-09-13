import { join } from "path";
import { resolveStatePaths } from "./state-paths";

export function keshaCacheDir(): string {
  return resolveStatePaths().cacheDir.path;
}

/** The `.exe` suffix is a platform fact, not a per-target one: an extensionless PE is not reliably spawnable. */
export function defaultEngineBinPath(platform = process.platform): string {
  const basename = platform === "win32" ? "kesha-engine.exe" : "kesha-engine";
  return join(keshaCacheDir(), "engine", "bin", basename);
}
