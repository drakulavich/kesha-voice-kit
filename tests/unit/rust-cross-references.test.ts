import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRepoFile, repoPath } from "../helpers/repo";

/**
 * TS comments and hint strings point readers at the Rust symbol they mirror. Nothing kept those
 * pointers honest, so the #950 `models.rs` split left 14 of them aimed at a deleted file (#1132).
 */
const FILE_REFERENCE = /\b((?:rust\/)?(?:[a-z0-9_]+\/)*[a-z0-9_]+\.rs)(?:::([A-Za-z0-9_]+))?/g;

/** The `mod::sym` form carries no `.rs`; the lookbehind keeps `init.ts::initCommand` and paths out. */
const MODULE_REFERENCE = /(?<![\w./])([a-z][a-z0-9_]*(?:::[a-z][a-z0-9_]*)*)::([A-Za-z0-9_]+)/g;

const DECLARATION = "(?:fn|const|static|struct|enum|trait|type|union|mod|macro_rules!)";

/**
 * A declaration, not a mention: a `use` line, a call site or a doc comment must not satisfy a
 * pointer, or every symbol could be retargeted at `models/mod.rs`'s re-export block (#1132 round 1).
 */
function declares(source: string, symbol: string): boolean {
  return new RegExp(`\\b${DECLARATION}\\s+${symbol}\\b`).test(source);
}

function tsSources(dir: string): string[] {
  return readdirSync(repoPath(dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** `rust/…` is repo-relative on purpose: `rust/build.rs` and `rust/tests/*.rs` are legal targets. */
function resolveFile(path: string): string {
  return path.startsWith("rust/") ? path : `rust/src/${path}`;
}

function resolveModule(path: string): string | undefined {
  const base = `rust/src/${path.split("::").join("/")}`;
  return [`${base}.rs`, `${base}/mod.rs`].find((candidate) => existsSync(repoPath(candidate)));
}

type Reference = { origin: string; label: string; file?: string; symbol?: string; kind: string };

function referencesIn(origin: string): Reference[] {
  const source = readRepoFile(origin);
  const files = [...source.matchAll(FILE_REFERENCE)].flatMap<Reference>(([, path, symbol]) =>
    path
      ? [
          {
            origin,
            label: symbol ? `${path}::${symbol}` : path,
            file: resolveFile(path),
            symbol,
            kind: symbol ? "file-with-symbol" : "file",
          },
        ]
      : [],
  );
  const modules = [...source.matchAll(MODULE_REFERENCE)].flatMap<Reference>(([, path, symbol]) =>
    path && symbol
      ? [{ origin, label: `${path}::${symbol}`, file: resolveModule(path), symbol, kind: "module" }]
      : [],
  );
  return [...files, ...modules];
}

const references: Reference[] = tsSources("src").flatMap(referencesIn);

const countOf = (kind: string) => references.filter((reference) => reference.kind === kind).length;

describe("Rust cross-references in TS sources", () => {
  // Per shape, not a global total: a narrowing that loses one whole form must not pass on the others (#1132 round 1).
  test("the scan finds every shape it is meant to gate", () => {
    expect(countOf("file-with-symbol")).toBeGreaterThanOrEqual(20);
    expect(countOf("file")).toBeGreaterThanOrEqual(2);
    expect(countOf("module")).toBeGreaterThanOrEqual(1);
  });

  test("every referenced Rust file exists", () => {
    const dangling = references
      .filter(({ file }) => !file || !existsSync(repoPath(file)))
      .map(({ origin, label }) => `${origin} → ${label}`);
    expect(dangling).toEqual([]);
  });

  test("every referenced Rust symbol is declared in the file it names", () => {
    const missing = references
      .filter(({ file, symbol }) => symbol && file && existsSync(repoPath(file)) && !declares(readRepoFile(file), symbol))
      .map(({ origin, label }) => `${origin} → ${label}`);
    expect(missing).toEqual([]);
  });
});
