import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./repo";

const SINGLE_FILE = join(REPO_ROOT, "rust", "src", "models.rs");
const MODULE_DIR = join(REPO_ROOT, "rust", "src", "models");

/**
 * The engine sources every model pin lives in, whether `models` is one file or a directory.
 *
 * Sorted so the concatenation is byte-identical run to run regardless of `readdirSync`'s platform-
 * dependent order — not for macro expansion: `.github/scripts/check-model-plan-sizes.ts` collects
 * every `macro_rules!` in one pass over the whole joined source before expanding any call site, so
 * declaration order doesn't matter there (#950).
 */
export function rustModelsSourcePaths(): string[] {
  if (existsSync(SINGLE_FILE)) return [SINGLE_FILE];
  if (existsSync(MODULE_DIR)) {
    const files = readdirSync(MODULE_DIR, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".rs"))
      .sort()
      .map((entry) => join(MODULE_DIR, entry));
    if (files.length > 0) return files;
  }
  throw new Error(
    `no engine model manifest source: neither ${SINGLE_FILE} nor any ${MODULE_DIR}/*.rs exists`,
  );
}

/** Every model pin the engine declares, as one source string. */
export function rustModelsSource(): string {
  return rustModelsSourcePaths()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}
