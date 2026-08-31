import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRepoFile, repoPath } from "../helpers/repo";

/**
 * TS comments and hint strings point readers at the Rust symbol they mirror. Nothing kept those
 * pointers honest, so the #950 `models.rs` split left ~15 of them aimed at a deleted file (#1132).
 */
const REFERENCE = /\b((?:rust\/src\/)?(?:[a-z0-9_]+\/)*[a-z0-9_]+\.rs)(?:::([A-Za-z0-9_]+))?/g;

function tsSources(dir: string): string[] {
  return readdirSync(repoPath(dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

type Reference = { origin: string; rustPath: string; symbol?: string };

const references: Reference[] = tsSources("src").flatMap((origin) =>
  [...readRepoFile(origin).matchAll(REFERENCE)].map(([, path, symbol]) => ({
    origin,
    rustPath: path.replace(/^rust\/src\//, ""),
    symbol,
  })),
);

describe("Rust cross-references in TS sources", () => {
  // Without this the two gates below would pass by finding nothing to check.
  test("the scan finds the references it is meant to gate", () => {
    expect(references.length).toBeGreaterThanOrEqual(20);
  });

  test("every referenced Rust file exists", () => {
    const dangling = references
      .filter(({ rustPath }) => !existsSync(repoPath(`rust/src/${rustPath}`)))
      .map(({ origin, rustPath }) => `${origin} → rust/src/${rustPath}`);
    expect(dangling).toEqual([]);
  });

  test("every referenced Rust symbol is defined in the file it names", () => {
    const missing = references
      .filter(({ rustPath, symbol }) => {
        if (!symbol || !existsSync(repoPath(`rust/src/${rustPath}`))) return false;
        return !new RegExp(`\\b${symbol}\\b`).test(readRepoFile(`rust/src/${rustPath}`));
      })
      .map(({ origin, rustPath, symbol }) => `${origin} → rust/src/${rustPath}::${symbol}`);
    expect(missing).toEqual([]);
  });
});
