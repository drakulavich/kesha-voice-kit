import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./repo";

const MODULE_DIR = join(REPO_ROOT, "rust", "src", "models");

/**
 * The engine sources every model pin lives in.
 *
 * Sorted so the concatenation is byte-identical run to run regardless of `readdirSync`'s platform-
 * dependent order — not for macro expansion: the plan-size script collects every `macro_rules!` in
 * one pass over the whole joined source before expanding any call site, so order doesn't matter
 * there (#950).
 */
export function rustModelsSourcePaths(): string[] {
  if (existsSync(MODULE_DIR)) {
    const files = readdirSync(MODULE_DIR, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".rs"))
      .sort()
      .map((entry) => join(MODULE_DIR, entry));
    if (files.length > 0) return files;
  }
  throw new Error(`no engine model manifest source: no .rs files under ${MODULE_DIR}`);
}

/** Every model pin the engine declares, as one source string. */
export function rustModelsSource(): string {
  return rustModelsSourcePaths()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}
